import { DurableObject } from "cloudflare:workers";
import coreWorker, { MusicaSalvajeAgent as BaseMusicaSalvajeAgent } from "./worker";

interface ReservationState {
  id: string;
  day: string;
  month: string;
  createdAt: string;
}

const RESERVATION_TTL_MS = 30 * 60 * 1000;

function dayKey(now = new Date()): string { return now.toISOString().slice(0, 10); }
function monthKey(now = new Date()): string { return now.toISOString().slice(0, 7); }

export function isReservationStale(reservation: Pick<ReservationState, "createdAt">, now = Date.now()): boolean {
  const createdAt = Date.parse(reservation.createdAt);
  return !Number.isFinite(createdAt) || now - createdAt > RESERVATION_TTL_MS;
}

export class MusicaSalvajeAgent extends BaseMusicaSalvajeAgent {
  async pollRender(payload: { catalogId: string; attempt: number; poll: number }): Promise<void> {
    const render = this.getRender(payload.catalogId);
    if (!render || render.attempt !== payload.attempt || render.status === "SUCCESS") return;

    const fail = (message: string) => {
      const now = new Date().toISOString();
      this.sql`UPDATE render_jobs SET status='FAILED',last_checked_at=${now},error=${message} WHERE catalog_id=${payload.catalogId}`;
      this.sql`UPDATE songs SET status='RENDER_FAILED',updated_at=${now},error=${message} WHERE catalog_id=${payload.catalogId}`;
    };

    if (!this.env.GITHUB_TOKEN) {
      fail("GITHUB_TOKEN is required to poll private draft render releases");
      return;
    }

    const repo = this.env.GITHUB_REPO ?? "Savage9323/Musica-Salvaje";
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "musica-salvaje-agent"
    };

    try {
      const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100`, { headers });
      if (!response.ok) throw new Error(`GitHub draft release check HTTP ${response.status}: ${await response.text()}`);
      const releases = await response.json() as Array<{
        tag_name?: string;
        draft?: boolean;
        assets?: Array<{ name?: string; url?: string }>;
      }>;
      const release = releases.find((item) => item.tag_name === payload.catalogId && item.draft === true);
      const asset = release?.assets?.find((item) => item.name?.toLowerCase().endsWith(".mp4") && item.url);
      if (asset?.url) {
        const now = new Date().toISOString();
        this.sql`UPDATE render_jobs SET status='SUCCESS',last_checked_at=${now},video_url=${asset.url},error=NULL WHERE catalog_id=${payload.catalogId}`;
        this.sql`UPDATE songs SET status='VIDEO_READY',updated_at=${now},error=NULL WHERE catalog_id=${payload.catalogId}`;
        await this.preparePublishing(payload.catalogId, asset.url);
        return;
      }

      if (payload.poll >= 15) {
        fail("Private renderer polling timed out; retrying render never regenerates music");
        return;
      }
      this.sql`UPDATE render_jobs SET status='RUNNING',last_checked_at=${new Date().toISOString()} WHERE catalog_id=${payload.catalogId}`;
      await this.schedule(Math.min(180, 20 + payload.poll * 10), "pollRender", { ...payload, poll: payload.poll + 1 });
    } catch (error) {
      if (payload.poll >= 15) fail(error instanceof Error ? error.message : String(error));
      else await this.schedule(Math.min(180, 30 + payload.poll * 10), "pollRender", { ...payload, poll: payload.poll + 1 });
    }
  }
}

export class BudgetGate extends DurableObject<Env> {
  private async cleanupStaleReservations(): Promise<number> {
    const reservations = await this.ctx.storage.list<ReservationState>({ prefix: "reservation:" });
    let released = 0;
    for (const [key, reservation] of reservations) {
      if (!isReservationStale(reservation)) continue;
      const dayReserved = Number(await this.ctx.storage.get<number>(`reserved:day:${reservation.day}`) ?? 0);
      const monthReserved = Number(await this.ctx.storage.get<number>(`reserved:month:${reservation.month}`) ?? 0);
      await this.ctx.storage.put(`reserved:day:${reservation.day}`, Math.max(0, dayReserved - 1));
      await this.ctx.storage.put(`reserved:month:${reservation.month}`, Math.max(0, monthReserved - 1));
      await this.ctx.storage.delete(key);
      released++;
    }
    return released;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.json().catch(() => ({})) as Record<string, unknown> : {};
    if (url.pathname === "/reserve" && request.method === "POST") {
      await this.cleanupStaleReservations();
      const maxDaily = Math.max(0, Math.trunc(Number(body.maxDaily ?? 0)));
      const maxMonthly = Math.max(0, Math.trunc(Number(body.maxMonthly ?? 0)));
      if (maxDaily < 1 || maxMonthly < 1) return Response.json({ ok: false, error: "Live daily and monthly generation limits must be explicit positive integers" }, { status: 423 });
      const day = dayKey(); const month = monthKey();
      const dailyUsed = Number(await this.ctx.storage.get<number>(`used:day:${day}`) ?? 0);
      const monthlyUsed = Number(await this.ctx.storage.get<number>(`used:month:${month}`) ?? 0);
      const dailyReserved = Number(await this.ctx.storage.get<number>(`reserved:day:${day}`) ?? 0);
      const monthlyReserved = Number(await this.ctx.storage.get<number>(`reserved:month:${month}`) ?? 0);
      if (dailyUsed + dailyReserved >= maxDaily) return Response.json({ ok: false, error: `Daily live-generation limit reached (${maxDaily})`, dailyUsed, dailyReserved, monthlyUsed, monthlyReserved }, { status: 429 });
      if (monthlyUsed + monthlyReserved >= maxMonthly) return Response.json({ ok: false, error: `Monthly live-generation limit reached (${maxMonthly})`, dailyUsed, dailyReserved, monthlyUsed, monthlyReserved }, { status: 429 });
      const id = crypto.randomUUID();
      const reservation: ReservationState = { id, day, month, createdAt: new Date().toISOString() };
      await this.ctx.storage.put(`reservation:${id}`, reservation);
      await this.ctx.storage.put(`reserved:day:${day}`, dailyReserved + 1);
      await this.ctx.storage.put(`reserved:month:${month}`, monthlyReserved + 1);
      return Response.json({ ok: true, reservation, dailyUsed, monthlyUsed });
    }
    if ((url.pathname === "/commit" || url.pathname === "/release") && request.method === "POST") {
      const id = String(body.id ?? "");
      const reservation = id ? await this.ctx.storage.get<ReservationState>(`reservation:${id}`) : undefined;
      if (!reservation) return Response.json({ ok: true, changed: false });
      const dayReserved = Number(await this.ctx.storage.get<number>(`reserved:day:${reservation.day}`) ?? 0);
      const monthReserved = Number(await this.ctx.storage.get<number>(`reserved:month:${reservation.month}`) ?? 0);
      await this.ctx.storage.put(`reserved:day:${reservation.day}`, Math.max(0, dayReserved - 1));
      await this.ctx.storage.put(`reserved:month:${reservation.month}`, Math.max(0, monthReserved - 1));
      if (url.pathname === "/commit") {
        const dayUsed = Number(await this.ctx.storage.get<number>(`used:day:${reservation.day}`) ?? 0);
        const monthUsed = Number(await this.ctx.storage.get<number>(`used:month:${reservation.month}`) ?? 0);
        await this.ctx.storage.put(`used:day:${reservation.day}`, dayUsed + 1);
        await this.ctx.storage.put(`used:month:${reservation.month}`, monthUsed + 1);
      }
      await this.ctx.storage.delete(`reservation:${id}`);
      return Response.json({ ok: true, changed: true });
    }
    if (url.pathname === "/status" && request.method === "GET") {
      const staleReservationsReleased = await this.cleanupStaleReservations();
      const day = dayKey(); const month = monthKey();
      return Response.json({ ok: true,
        dailyUsed: Number(await this.ctx.storage.get<number>(`used:day:${day}`) ?? 0),
        dailyReserved: Number(await this.ctx.storage.get<number>(`reserved:day:${day}`) ?? 0),
        monthlyUsed: Number(await this.ctx.storage.get<number>(`used:month:${month}`) ?? 0),
        monthlyReserved: Number(await this.ctx.storage.get<number>(`reserved:month:${month}`) ?? 0),
        staleReservationsReleased, day, month });
    }
    return new Response("Not found", { status: 404 });
  }
}

function secureEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a); const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length; const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) diff |= (left[i % Math.max(1, left.length)] ?? 0) ^ (right[i % Math.max(1, right.length)] ?? 0);
  return diff === 0;
}

export function isAdminAuthorized(request: Request, env: Env): boolean {
  const localTestAccess = env.TEST_MODE !== "false" && env.ALLOW_UNAUTHENTICATED_TEST_API === "true" && !env.ADMIN_API_TOKEN;
  if (localTestAccess) return true;
  if (!env.ADMIN_API_TOKEN) return false;
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") && secureEqual(header.slice(7), env.ADMIN_API_TOKEN);
}

function isCallback(pathname: string): boolean { return pathname === "/api/callbacks/suno"; }
function isPublicMedia(pathname: string): boolean { return pathname.startsWith("/api/media/"); }
function isTestMedia(pathname: string, env: Env): boolean {
  return env.TEST_MODE !== "false" && (pathname === "/api/test/audio.wav" || pathname === "/api/test/cover.svg");
}
function isProtectedApi(request: Request, pathname: string, env: Env): boolean {
  if (request.method === "OPTIONS") return false;
  if (!pathname.startsWith("/api/")) return false;
  return !isCallback(pathname) && !isPublicMedia(pathname) && !isTestMedia(pathname, env);
}

function hardenResponse(request: Request, response: Response): Response {
  const url = new URL(request.url);
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-frame-options", "DENY");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  if (url.pathname.startsWith("/api/")) headers.set("cache-control", "no-store");
  const contentType = headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    headers.set("cache-control", "no-store");
    headers.set("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: https:; media-src 'self' https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function reserveBudget(env: Env): Promise<{ id: string } | Response> {
  if (env.LIVE_GENERATION_ENABLED !== "true") return Response.json({ ok: false, error: "Live generation is locked. Set LIVE_GENERATION_ENABLED=true only after credentials and limits are verified." }, { status: 423 });
  const maxDaily = Math.trunc(Number(env.MAX_DAILY_PAID_GENERATIONS ?? "0"));
  const maxMonthly = Math.trunc(Number(env.MAX_MONTHLY_PAID_GENERATIONS ?? "0"));
  const stub = env.BudgetGate.get(env.BudgetGate.idFromName("global"));
  const response = await stub.fetch("https://budget.local/reserve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxDaily, maxMonthly }) });
  if (!response.ok) return new Response(response.body, { status: response.status, headers: { "content-type": "application/json" } });
  const body = await response.json() as { reservation: { id: string } };
  return { id: body.reservation.id };
}

async function finishReservation(env: Env, id: string, action: "commit" | "release") {
  const stub = env.BudgetGate.get(env.BudgetGate.idFromName("global"));
  await stub.fetch(`https://budget.local/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
}

async function handleLiveSong(request: Request, env: Env): Promise<Response> {
  if (!isAdminAuthorized(request, env)) return Response.json({ ok: false, error: "Admin authorization required" }, { status: 401 });
  const reservation = await reserveBudget(env);
  if (reservation instanceof Response) return reservation;
  try {
    const response = await coreWorker.fetch(request, env);
    const clone = response.clone();
    const body = await clone.json().catch(() => null) as null | { duplicate?: boolean; song?: { paidGeneration?: boolean; status?: string } };
    const definitelyNoPaidAttempt = Boolean(body?.duplicate) || ["QUALITY_REJECTED", "BUDGET_BLOCKED"].includes(String(body?.song?.status ?? ""));
    if (response.ok && body?.song?.paidGeneration === true && !body?.duplicate) await finishReservation(env, reservation.id, "commit");
    else if (definitelyNoPaidAttempt) await finishReservation(env, reservation.id, "release");
    else await finishReservation(env, reservation.id, "commit");
    return response;
  } catch (error) {
    await finishReservation(env, reservation.id, "commit");
    throw error;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const finish = (response: Response) => hardenResponse(request, response);

    if (url.pathname.startsWith("/agents/") && env.TEST_MODE === "false") {
      return finish(Response.json({ ok: false, error: "Agent transport is disabled in production" }, { status: 404 }));
    }

    if (isProtectedApi(request, url.pathname, env) && !isAdminAuthorized(request, env)) {
      return finish(Response.json({ ok: false, error: "Admin authorization required" }, { status: 401 }));
    }

    if (url.pathname === "/api/live-budget" && request.method === "GET") {
      const stub = env.BudgetGate.get(env.BudgetGate.idFromName("global"));
      const response = await stub.fetch("https://budget.local/status");
      const ledger = await response.json();
      return finish(Response.json({ ok: true, liveEnabled: env.LIVE_GENERATION_ENABLED === "true", maxDaily: Number(env.MAX_DAILY_PAID_GENERATIONS ?? 0), maxMonthly: Number(env.MAX_MONTHLY_PAID_GENERATIONS ?? 0), ledger }));
    }

    if (url.pathname === "/api/songs" && request.method === "POST") {
      const body = await request.clone().json().catch(() => ({})) as { testOnly?: boolean };
      if (body.testOnly !== true) return finish(await handleLiveSong(request, env));
    }
    return finish(await coreWorker.fetch(request, env));
  }
} satisfies ExportedHandler<Env>;

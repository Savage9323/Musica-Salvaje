import { DurableObject } from "cloudflare:workers";
import coreWorker, { MusicaSalvajeAgent } from "./worker";

interface ReservationState {
  id: string;
  day: string;
  month: string;
  createdAt: string;
}

function dayKey(now = new Date()): string { return now.toISOString().slice(0, 10); }
function monthKey(now = new Date()): string { return now.toISOString().slice(0, 7); }

export class BudgetGate extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.json().catch(() => ({})) as Record<string, unknown> : {};
    if (url.pathname === "/reserve" && request.method === "POST") {
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
      const day = dayKey(); const month = monthKey();
      return Response.json({ ok: true,
        dailyUsed: Number(await this.ctx.storage.get<number>(`used:day:${day}`) ?? 0),
        dailyReserved: Number(await this.ctx.storage.get<number>(`reserved:day:${day}`) ?? 0),
        monthlyUsed: Number(await this.ctx.storage.get<number>(`used:month:${month}`) ?? 0),
        monthlyReserved: Number(await this.ctx.storage.get<number>(`reserved:month:${month}`) ?? 0), day, month });
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
  if (env.TEST_MODE !== "false" && !env.ADMIN_API_TOKEN) return true;
  if (!env.ADMIN_API_TOKEN) return false;
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") && secureEqual(header.slice(7), env.ADMIN_API_TOKEN);
}

function isCallback(pathname: string): boolean { return pathname === "/api/callbacks/suno"; }
function isPublicMedia(pathname: string): boolean { return pathname.startsWith("/api/media/"); }
function isProtectedApi(request: Request, pathname: string): boolean {
  if (request.method === "OPTIONS") return false;
  if (!pathname.startsWith("/api/")) return false;
  return !isCallback(pathname) && !isPublicMedia(pathname);
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

    // The Cloudflare Agents transport is useful in local/test mode, but must not
    // provide a production bypass around the authenticated Studio/API gateway.
    if (url.pathname.startsWith("/agents/") && env.TEST_MODE === "false") {
      return Response.json({ ok: false, error: "Agent transport is disabled in production" }, { status: 404 });
    }

    // In production, catalog/status/control APIs are private. Suno callbacks use
    // their own callback secret and archived media remains readable for FFmpeg.
    if (isProtectedApi(request, url.pathname) && !isAdminAuthorized(request, env)) {
      return Response.json({ ok: false, error: "Admin authorization required" }, { status: 401 });
    }

    if (url.pathname === "/api/live-budget" && request.method === "GET") {
      const stub = env.BudgetGate.get(env.BudgetGate.idFromName("global"));
      const response = await stub.fetch("https://budget.local/status");
      const ledger = await response.json();
      return Response.json({ ok: true, liveEnabled: env.LIVE_GENERATION_ENABLED === "true", maxDaily: Number(env.MAX_DAILY_PAID_GENERATIONS ?? 0), maxMonthly: Number(env.MAX_MONTHLY_PAID_GENERATIONS ?? 0), ledger });
    }

    if (url.pathname === "/api/songs" && request.method === "POST") {
      const body = await request.clone().json().catch(() => ({})) as { testOnly?: boolean };
      if (body.testOnly !== true) return handleLiveSong(request, env);
    }
    return coreWorker.fetch(request, env);
  }
} satisfies ExportedHandler<Env>;

export { MusicaSalvajeAgent };

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks de módulos con efectos (DB, WhatsApp, env) ────────────────────────
vi.mock("../../src/config/env.js", () => ({
  env: {
    NODE_ENV: "test",
    FORJA_MODE: "amateur",
    TZ: "America/Argentina/Buenos_Aires",
  },
}));
vi.mock("../../src/repositories/training.repo.js", () => ({
  getTodayPlan: vi.fn(),
  getAllActivePlans: vi.fn(),
  logTrainingComplete: vi.fn(),
  logTrainingSkip: vi.fn(),
  setRpe: vi.fn(),
}));
vi.mock("../../src/repositories/daily.repo.js", () => ({
  refreshDailySummary: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/evolution.service.js", () => ({
  sendText: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/events.service.js", () => ({
  logBotEvent: vi.fn(),
  // Cada constante devuelve su propio nombre — suficiente para los asserts.
  EventTypes: new Proxy({}, { get: (_t, p) => String(p) }),
}));

import type { User } from "../../src/types/user.types.js";
import * as trainingRepo from "../../src/repositories/training.repo.js";
import { sendText } from "../../src/services/evolution.service.js";
import { logBotEvent } from "../../src/services/events.service.js";
import {
  handleComplete,
  extractSessionName,
  isGenericSessionName,
} from "../../src/bot/handlers/training.handler.js";
import { invalidateUserDict } from "../../src/bot/parser/training-matcher.js";

const TZ = "America/Argentina/Buenos_Aires";

function todayDow(): number {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(new Date());
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[wd] ?? new Date().getDay();
}

const user = {
  id: "user-offplan-test",
  wa_chat_id: "5491100000000@s.whatsapp.net",
  timezone: TZ,
} as unknown as User;

const PLAN_HOY = {
  id: "plan-hoy",
  day_of_week: todayDow(),
  session_type: "gym",
  session_name: "Piernas B",
  exercises: [{ name: "Sentadilla", aliases: ["squat"] }],
};
const PLAN_OTRO_DIA = {
  id: "plan-otro",
  day_of_week: (todayDow() + 2) % 7,
  session_type: "gym",
  session_name: "Empuje A",
  exercises: [{ name: "Press de banca", aliases: ["press banca", "bench"] }],
};

function lastMessage(): string {
  const calls = vi.mocked(sendText).mock.calls;
  return String(calls[calls.length - 1][1]);
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidateUserDict(user.id);
  vi.mocked(trainingRepo.getTodayPlan).mockResolvedValue(PLAN_HOY as any);
  vi.mocked(trainingRepo.getAllActivePlans).mockResolvedValue([PLAN_HOY, PLAN_OTRO_DIA] as any);
  vi.mocked(trainingRepo.logTrainingComplete).mockResolvedValue({ id: "log-1" } as any);
});

describe("handleComplete — sesión que NO está en el plan", () => {
  it("con entidad de la AI ('brazos'): registra SUS palabras, sin plan_id, y avisa off-plan", async () => {
    await handleComplete(user, "entrene brazos completo me sali de la rutina", {
      sessionText: "brazos",
      offPlan: true,
    });

    expect(trainingRepo.logTrainingComplete).toHaveBeenCalledWith(user, "brazos", undefined);
    const msg = lastMessage();
    expect(msg).toContain("brazos");
    expect(msg).toContain("no estaba en tu plan");
    expect(msg).toContain("Piernas B"); // le recuerda qué tenía hoy
    expect(logBotEvent).toHaveBeenCalledWith(
      user.id,
      "TRAINING_OFF_PLAN",
      expect.objectContaining({ done_session: "brazos", planned_session: "Piernas B" }),
    );
  });

  it("sin AI (rescate regex): 'entrene brazos completo...' también extrae 'brazos' y va off-plan", async () => {
    await handleComplete(user, "entrene brazos completo me sali de la rutina", undefined);

    expect(trainingRepo.logTrainingComplete).toHaveBeenCalledWith(user, "brazos", undefined);
    expect(lastMessage()).toContain("no estaba en tu plan");
  });

  it("NUNCA registra la sesión planificada de hoy cuando el usuario nombró otra cosa", async () => {
    await handleComplete(user, "entrene brazos completo", { sessionText: "brazos", offPlan: false });

    const [, sessionName, planId] = vi.mocked(trainingRepo.logTrainingComplete).mock.calls[0];
    expect(sessionName).not.toBe("Piernas B");
    expect(planId).toBeUndefined();
  });
});

describe("handleComplete — caminos que SÍ van al plan", () => {
  it("'listo' sin nombrar nada → asume la sesión de hoy", async () => {
    await handleComplete(user, "listo", undefined);
    expect(trainingRepo.logTrainingComplete).toHaveBeenCalledWith(user, "Piernas B", "plan-hoy");
    expect(lastMessage()).toContain("Piernas B");
  });

  it("nombre genérico de la AI ('lo de hoy') NO es off-plan → sesión de hoy", async () => {
    await handleComplete(user, "hice lo de hoy", { sessionText: "lo de hoy", offPlan: false });
    expect(trainingRepo.logTrainingComplete).toHaveBeenCalledWith(user, "Piernas B", "plan-hoy");
  });

  it("'hice piernas' matchea la sesión de hoy → registro normal con plan_id", async () => {
    await handleComplete(user, "hice piernas", { sessionText: "piernas", offPlan: false });
    expect(trainingRepo.logTrainingComplete).toHaveBeenCalledWith(user, "Piernas B", "plan-hoy");
    expect(lastMessage()).not.toContain("no estaba en tu plan");
  });

  it("'hice empuje' (sesión de otro día) → swap, no off-plan", async () => {
    await handleComplete(user, "hice empuje", { sessionText: "empuje", offPlan: false });
    expect(trainingRepo.logTrainingComplete).toHaveBeenCalledWith(user, "Empuje A", "plan-otro");
    expect(lastMessage()).toContain("cambiaste de orden");
  });

  it("off-plan en día de descanso: registra sin recordar plan", async () => {
    vi.mocked(trainingRepo.getTodayPlan).mockResolvedValue({
      id: "plan-rest", day_of_week: todayDow(), session_type: "descanso", session_name: null, exercises: [],
    } as any);
    await handleComplete(user, "entrene brazos", { sessionText: "brazos", offPlan: false });
    expect(trainingRepo.logTrainingComplete).toHaveBeenCalledWith(user, "brazos", undefined);
    expect(lastMessage()).not.toContain("hoy tenías");
  });
});

describe("extractSessionName (rescate sin AI)", () => {
  it.each([
    ["entrene brazos completo me sali de la rutina", "brazos"],
    ["complete piernas", "piernas"],
    ["complete piernas hoy", "piernas"],
    ["hoy hice espalda", "espalda"],
    ["ya entrene pecho", "pecho"],
    ["entrenamos hombros y biceps", "hombros"],
    ["listo el gym a full", "gym"], // "gym" es genérico → cae al plan de hoy, no off-plan
  ])("%s → %s", (input, expected) => {
    expect(extractSessionName(input)).toBe(expected);
  });

  it.each(["listo", "ya entrene", "termine"])("%s → null (no nombró nada)", (input) => {
    expect(extractSessionName(input)).toBeNull();
  });
});

describe("isGenericSessionName", () => {
  it.each(["lo de hoy", "el entrenamiento", "la rutina", "el gym", "todo", "mi sesion de hoy"])(
    "'%s' es genérico",
    (name) => expect(isGenericSessionName(name)).toBe(true),
  );
  it.each(["brazos", "piernas", "corri 5k", "natacion", "el gym de brazos"])(
    "'%s' NO es genérico",
    (name) => expect(isGenericSessionName(name)).toBe(false),
  );
});

import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { SchedulerService } from "../scheduler.ts";
import type { ScheduleRow } from "../schedules.ts";

const scheduleParams = Type.Object({
  prompt: Type.String({
    description:
      "The instruction you will receive when this fires. Write it to your future self — it arrives as a [Scheduled task ...] message with no other context.",
  }),
  label: Type.String({ description: "Short human-readable label (3-6 words)" }),
  at: Type.Optional(
    Type.String({
      description: 'One-shot fire time as an ISO 8601 timestamp, e.g. "2026-06-10T09:00:00-04:00". Exactly one of at/cron.',
    }),
  ),
  cron: Type.Optional(
    Type.String({
      description:
        'Recurring schedule as a 5-field cron expression in SERVER LOCAL TIME, e.g. "0 9 * * 1-5" for 9am weekdays. Exactly one of at/cron.',
    }),
  ),
  target: Type.Optional(
    Type.Union([Type.Literal("this_session"), Type.Literal("new_session")], {
      description: "Where the fire message lands. Default this_session; new_session opens a fresh conversation at fire time.",
    }),
  ),
});

const scheduleIdParams = Type.Object({ scheduleId: Type.String() });

function describeRow(row: ScheduleRow): string {
  const spec = row.spec.type === "once" ? `once at ${row.spec.at}` : `cron "${row.spec.expr}"`;
  const state = row.cancelled ? "cancelled" : row.enabled ? `next fire ${row.nextFireAt}` : "completed";
  return `${row.id} ("${row.label}") — ${spec}; ${state}; fired ${row.firedCount}x`;
}

export function createSchedulingTools(
  getScheduler: () => SchedulerService,
  sessionId: string,
): AgentTool<any>[] {
  const schedule: AgentTool<typeof scheduleParams> = {
    name: "schedule",
    label: "Schedule a task",
    description:
      "Schedule a one-shot reminder (at) or recurring job (cron) for yourself. When it fires you receive the prompt as a [Scheduled task ...] message and act on it. Use for reminders, recurring briefings, or deferred work.",
    parameters: scheduleParams,
    execute: async (_id, params) => {
      if (!params.at === !params.cron) {
        throw new Error("Provide exactly one of `at` (one-shot) or `cron` (recurring)");
      }
      const spec = params.at
        ? ({ type: "once", at: new Date(params.at).toISOString() } as const)
        : ({ type: "cron", expr: params.cron! } as const);
      const row = getScheduler().create({
        label: params.label,
        prompt: params.prompt,
        spec,
        targetSessionId: params.target === "new_session" ? null : sessionId,
      });
      return {
        content: [
          {
            type: "text",
            text: `Scheduled ${row.id} ("${row.label}"): ${row.spec.type === "once" ? `fires once at ${row.nextFireAt}` : `recurring, next fire ${row.nextFireAt}`}.`,
          },
        ],
        details: { scheduleId: row.id },
      };
    },
  };

  const listSchedules: AgentTool<any> = {
    name: "list_schedules",
    label: "List schedules",
    description: "List all schedules with their status and next fire time.",
    parameters: Type.Object({}),
    execute: async () => {
      const rows = getScheduler().list();
      return {
        content: [
          { type: "text", text: rows.length ? rows.map(describeRow).join("\n") : "(no schedules)" },
        ],
        details: { count: rows.length },
      };
    },
  };

  const cancelSchedule: AgentTool<typeof scheduleIdParams> = {
    name: "cancel_schedule",
    label: "Cancel schedule",
    description: "Cancel an active schedule by id.",
    parameters: scheduleIdParams,
    execute: async (_id, params) => {
      const ok = getScheduler().cancel(params.scheduleId);
      return {
        content: [
          { type: "text", text: ok ? `Cancelled schedule ${params.scheduleId}.` : `Schedule ${params.scheduleId} is not active (unknown, completed, or already cancelled).` },
        ],
        details: { cancelled: ok },
      };
    },
  };

  return [schedule, listSchedules, cancelSchedule];
}

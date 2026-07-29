import { createHash } from "node:crypto";

import type {
  FeishuAttendeeMutationFacts,
  FeishuCalendarAttendeeTarget,
  FeishuCalendarBackend,
  FeishuCalendarEventFacts,
  FeishuCalendarFacts,
  FeishuDeleteEventFacts,
  FeishuFreeBusyFacts,
} from "./calendar-contracts.js";
import {
  FeishuProviderBackendError,
} from "./contracts.js";
import type {
  FeishuOpenApiJson,
  FeishuOpenApiRequestClient,
} from "./openapi-backend.js";

export interface FeishuCalendarOpenApiBackendOptions {
  readonly requests: FeishuOpenApiRequestClient;
  readonly now?: () => string;
  readonly maximum_concurrency?: number;
}

function invalid(): never {
  throw new FeishuProviderBackendError(
    "feishu_response_invalid",
    true,
  );
}

function record(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) invalid();
  return value as Record<string, unknown>;
}

function string(
  value: unknown,
  maximum = 16_384,
  minimum = 1,
): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum
  ) invalid();
  return value;
}

function optionalString(
  value: unknown,
  maximum = 16_384,
): string | undefined {
  return value === undefined ? undefined : string(value, maximum, 0);
}

function epoch(value: unknown): string {
  const raw = string(value, 32);
  const numeric = Number(raw);
  if (!Number.isSafeInteger(numeric) || numeric < 0) invalid();
  return new Date(numeric * 1_000).toISOString();
}

function timeInfo(value: unknown): {
  readonly at: string;
  readonly time_zone: string;
} {
  const info = record(value);
  return {
    at: epoch(info.timestamp),
    time_zone: string(info.timezone, 255),
  };
}

function calendarFacts(value: unknown): FeishuCalendarFacts {
  const response = record(value);
  const data = record(response.data);
  const calendar = record(data.calendar);
  const calendarType = calendar.type;
  const accessRole = calendar.role;
  if (
    response.code !== 0 ||
    (calendarType !== "primary" && calendarType !== "shared") ||
    (accessRole !== "writer" && accessRole !== "owner")
  ) invalid();
  const description = optionalString(calendar.description);
  return {
    calendar_id: string(calendar.calendar_id, 512),
    summary: string(calendar.summary, 512),
    ...(description === undefined ? {} : { description }),
    calendar_type: calendarType,
    access_role: accessRole,
  };
}

function eventFacts(
  value: unknown,
  calendarId: string,
): FeishuCalendarEventFacts {
  const response = record(value);
  const data = record(response.data);
  const event = record(data.event);
  if (response.code !== 0) invalid();
  const start = timeInfo(event.start_time);
  const end = timeInfo(event.end_time);
  if (start.time_zone !== end.time_zone) invalid();
  const organizer = event.event_organizer === undefined
    ? undefined
    : record(event.event_organizer);
  const description = optionalString(event.description);
  const visibility = optionalString(event.visibility, 64);
  const attendeeAbility = optionalString(event.attendee_ability, 64);
  const organizerOpenId = organizer === undefined
    ? undefined
    : optionalString(organizer.organizer_id, 255);
  const url = optionalString(event.app_link, 2_048);
  const createdAt = event.create_time === undefined
    ? undefined
    : epoch(event.create_time);
  const updatedAt = event.update_time === undefined
    ? undefined
    : epoch(event.update_time);
  const attendees = event.attendees === undefined
    ? []
    : (() => {
        if (!Array.isArray(event.attendees) || event.attendees.length > 100) {
          invalid();
        }
        return event.attendees.map((raw) => {
          const attendee = record(raw);
          if (attendee.type === "user") {
            return {
              kind: "user" as const,
              open_id: string(
                attendee.user_id ?? attendee.attendee_id,
                255,
              ),
            };
          }
          if (attendee.type === "chat") {
            return {
              kind: "chat" as const,
              chat_id: string(
                attendee.chat_id ?? attendee.attendee_id,
                255,
              ),
            };
          }
          invalid();
        });
      })();
  return {
    calendar_id: calendarId,
    event_id: string(event.event_id, 512),
    title: string(event.summary, 512, 0),
    ...(description === undefined ? {} : { description }),
    start_at: start.at,
    end_at: end.at,
    time_zone: start.time_zone,
    ...(visibility === undefined ? {} : { visibility }),
    ...(attendeeAbility === undefined
      ? {}
      : { attendee_ability: attendeeAbility }),
    ...(organizerOpenId === undefined
      ? {}
      : { organizer_open_id: organizerOpenId }),
    attendees,
    ...(url === undefined ? {} : { url }),
    ...(createdAt === undefined ? {} : { created_at: createdAt }),
    ...(updatedAt === undefined ? {} : { updated_at: updatedAt }),
  };
}

function externalId(target: FeishuCalendarAttendeeTarget): string {
  return target.kind === "user" ? target.open_id : target.chat_id;
}

function attendeePayload(
  target: FeishuCalendarAttendeeTarget,
): FeishuOpenApiJson {
  return target.kind === "user"
    ? { type: "user", user_id: target.open_id }
    : { type: "chat", chat_id: target.chat_id };
}

function timePayload(at: string, timeZone: string) {
  return {
    timestamp: String(Math.floor(Date.parse(at) / 1_000)),
    timezone: timeZone,
  };
}

async function withConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<readonly R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, values.length) },
      async () => {
        for (;;) {
          const index = next;
          next += 1;
          if (index >= values.length) return;
          results[index] = await operation(values[index]!);
        }
      },
    ),
  );
  return results;
}

export class FeishuCalendarOpenApiBackend
  implements FeishuCalendarBackend {
  private readonly now: () => string;
  private readonly maximumConcurrency: number;

  constructor(private readonly options: FeishuCalendarOpenApiBackendOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.maximumConcurrency = options.maximum_concurrency ?? 3;
    if (
      !Number.isSafeInteger(this.maximumConcurrency) ||
      this.maximumConcurrency < 1 ||
      this.maximumConcurrency > 3
    ) throw new RangeError("Calendar concurrency is invalid");
  }

  async getCalendar(
    input: Parameters<FeishuCalendarBackend["getCalendar"]>[0],
  ): Promise<FeishuCalendarFacts> {
    return calendarFacts(await this.options.requests.request(
      "GET",
      `/open-apis/calendar/v4/calendars/${
        encodeURIComponent(input.calendar_id)
      }`,
      undefined,
      input.signal,
    ));
  }

  async createSharedCalendar(
    input: Parameters<FeishuCalendarBackend["createSharedCalendar"]>[0],
  ): Promise<FeishuCalendarFacts> {
    return this.write(async () =>
      calendarFacts(await this.options.requests.request(
        "POST",
        "/open-apis/calendar/v4/calendars",
        {
          summary: input.summary,
          ...(input.description === undefined
            ? {}
            : { description: input.description }),
          permissions: "private",
        },
        input.signal,
      ))
    );
  }

  async queryFreeBusy(
    input: Parameters<FeishuCalendarBackend["queryFreeBusy"]>[0],
  ): Promise<FeishuFreeBusyFacts> {
    const start = Date.parse(input.start_at);
    const end = Date.parse(input.end_at);
    if (
      input.user_open_ids.length < 1 ||
      input.user_open_ids.length > 100 ||
      new Set(input.user_open_ids).size !== input.user_open_ids.length ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start >= end ||
      end - start > 14 * 24 * 60 * 60 * 1_000
    ) {
      throw new FeishuProviderBackendError(
        "invalid_time_range",
        false,
      );
    }
    const chunks: Array<readonly string[]> = [];
    for (
      let offset = 0;
      offset < input.user_open_ids.length;
      offset += 10
    ) {
      chunks.push(input.user_open_ids.slice(offset, offset + 10));
    }
    const pages = await withConcurrency(
      chunks,
      this.maximumConcurrency,
      async (userIds) => {
        const response = record(await this.options.requests.request(
          "POST",
          "/open-apis/calendar/v4/freebusy/batch?user_id_type=open_id",
          {
            time_min: input.start_at,
            time_max: input.end_at,
            user_id_list: [...userIds],
            include_external_calendar: input.include_external_calendars,
            only_busy: input.busy_only,
          },
          input.signal,
        ));
        const data = record(response.data);
        if (response.code !== 0 || !Array.isArray(data.freebusy_list)) {
          invalid();
        }
        return data.freebusy_list;
      },
    );
    const byUser = new Map<string, {
      readonly open_id: string;
      readonly busy_intervals: readonly {
        readonly start_at: string;
        readonly end_at: string;
      }[];
    }>();
    const unresolvedByUser = new Map<string, string>();
    for (const raw of pages.flat()) {
      const item = record(raw);
      const openId = string(item.user_id, 255);
      if (item.error !== undefined) {
        const error = record(item.error);
        unresolvedByUser.set(
          openId,
          string(error.code, 128),
        );
        continue;
      }
      if (!Array.isArray(item.freebusy_list)) invalid();
      const intervals = item.freebusy_list.map((value) => {
        const interval = record(value);
        return {
          start_at: string(interval.start_time, 128),
          end_at: string(interval.end_time, 128),
        };
      }).sort((left, right) =>
        Date.parse(left.start_at) - Date.parse(right.start_at)
      );
      byUser.set(openId, { open_id: openId, busy_intervals: intervals });
    }
    return {
      start_at: input.start_at,
      end_at: input.end_at,
      participants: input.user_open_ids.flatMap((openId) => {
        const value = byUser.get(openId);
        return value === undefined ? [] : [value];
      }),
      unresolved: input.user_open_ids.flatMap((openId) => {
        if (byUser.has(openId)) return [];
        return [{
          open_id: openId,
          code: unresolvedByUser.get(openId) ?? "not_returned",
        }];
      }),
    };
  }

  async createEvent(
    input: Parameters<FeishuCalendarBackend["createEvent"]>[0],
  ): Promise<FeishuCalendarEventFacts> {
    const idempotencyKey = createHash("sha256")
      .update(input.idempotency_key)
      .digest("hex");
    const query = new URLSearchParams({
      user_id_type: "open_id",
      idempotency_key: idempotencyKey,
    });
    return this.write(async () =>
      eventFacts(await this.options.requests.request(
        "POST",
        `/open-apis/calendar/v4/calendars/${
          encodeURIComponent(input.calendar_id)
        }/events?${query.toString()}`,
        {
          summary: input.title,
          ...(input.description === undefined
            ? {}
            : { description: input.description }),
          start_time: timePayload(input.start_at, input.time_zone),
          end_time: timePayload(input.end_at, input.time_zone),
          ...(input.visibility === undefined
            ? {}
            : { visibility: input.visibility }),
          ...(input.attendee_ability === undefined
            ? {}
            : { attendee_ability: input.attendee_ability }),
          ...(input.reminders === undefined
            ? {}
            : {
                reminders: input.reminders.map((minutes) => ({ minutes })),
              }),
        },
        input.signal,
      ), input.calendar_id)
    );
  }

  async readEvent(
    input: Parameters<FeishuCalendarBackend["readEvent"]>[0],
  ): Promise<FeishuCalendarEventFacts> {
    return eventFacts(await this.options.requests.request(
      "GET",
      this.eventPath(input.calendar_id, input.event_id) +
        "?user_id_type=open_id",
      undefined,
      input.signal,
    ), input.calendar_id);
  }

  async updateEvent(
    input: Parameters<FeishuCalendarBackend["updateEvent"]>[0],
  ): Promise<FeishuCalendarEventFacts> {
    const changes: { [key: string]: FeishuOpenApiJson } = {};
    for (const field of input.field_mask) {
      const value = input.changes[field];
      switch (field) {
        case "title":
          changes.summary = value as FeishuOpenApiJson;
          break;
        case "start_at":
        case "end_at": {
          const timeZone = typeof input.changes.time_zone === "string"
            ? input.changes.time_zone
            : "UTC";
          changes[field === "start_at" ? "start_time" : "end_time"] =
            timePayload(value as string, timeZone);
          break;
        }
        case "time_zone":
          break;
        case "reminders":
          changes.reminders = (value as readonly number[])
            .map((minutes) => ({ minutes }));
          break;
        default:
          changes[field] = value as FeishuOpenApiJson;
      }
    }
    return this.write(async () =>
      eventFacts(await this.options.requests.request(
        "PATCH",
        this.eventPath(input.calendar_id, input.event_id) +
          "?user_id_type=open_id",
        changes,
        input.signal,
      ), input.calendar_id)
    );
  }

  addAttendees(
    input: Parameters<FeishuCalendarBackend["addAttendees"]>[0],
  ): Promise<FeishuAttendeeMutationFacts> {
    return this.mutateAttendees("POST", "added", input);
  }

  removeAttendees(
    input: Parameters<FeishuCalendarBackend["removeAttendees"]>[0],
  ): Promise<FeishuAttendeeMutationFacts> {
    return this.mutateAttendees("DELETE", "removed", input);
  }

  async deleteEvent(
    input: Parameters<FeishuCalendarBackend["deleteEvent"]>[0],
  ): Promise<FeishuDeleteEventFacts> {
    const query = new URLSearchParams({
      need_notification: String(input.need_notification),
    });
    await this.write(() =>
      this.options.requests.request(
        "DELETE",
        `${this.eventPath(input.calendar_id, input.event_id)}?${
          query.toString()
        }`,
        undefined,
        input.signal,
      )
    );
    return {
      calendar_id: input.calendar_id,
      event_id: input.event_id,
      deleted_at: this.now(),
    };
  }

  private async mutateAttendees(
    method: "POST" | "DELETE",
    outcome: "added" | "removed",
    input: Parameters<FeishuCalendarBackend["addAttendees"]>[0],
  ): Promise<FeishuAttendeeMutationFacts> {
    await this.write(() =>
      this.options.requests.request(
        method,
        `${this.eventPath(input.calendar_id, input.event_id)}` +
          "/attendees?user_id_type=open_id",
        {
          attendees: input.attendees.map(attendeePayload),
          need_notification: input.need_notification,
        },
        input.signal,
      )
    );
    return {
      attendees: input.attendees.map((target) => ({
        kind: target.kind,
        external_id: externalId(target),
        outcome,
      })),
    };
  }

  private eventPath(calendarId: string, eventId: string): string {
    return `/open-apis/calendar/v4/calendars/${
      encodeURIComponent(calendarId)
    }/events/${encodeURIComponent(eventId)}`;
  }

  private async write<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof FeishuProviderBackendError &&
        error.code === "deadline_exceeded"
      ) {
        throw new FeishuProviderBackendError(
          "external_outcome_unknown",
          false,
        );
      }
      throw error;
    }
  }
}

function segment(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value
  ) throw new TypeError(`Feishu Calendar ${field} resource is invalid`);
  return encodeURIComponent(value);
}

function decoded(value: string, field: string): string {
  let result: string;
  try {
    result = decodeURIComponent(value);
  } catch {
    throw new TypeError(`Feishu Calendar ${field} resource is invalid`);
  }
  if (
    result.length === 0 ||
    result.length > 512 ||
    result.trim() !== result ||
    /%[0-9a-f]{2}/i.test(result)
  ) throw new TypeError(`Feishu Calendar ${field} resource is invalid`);
  return result;
}

function resource(value: string): URL {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2_048
  ) throw new TypeError("Feishu Calendar resource is invalid");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Feishu Calendar resource is invalid");
  }
  if (
    url.protocol !== "feishu:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) throw new TypeError("Feishu Calendar resource is invalid");
  return url;
}

function path(url: URL): readonly string[] {
  if (!url.pathname.startsWith("/")) {
    throw new TypeError("Feishu Calendar resource is invalid");
  }
  const parts = url.pathname.slice(1).split("/");
  if (parts.some((part) => part.length === 0)) {
    throw new TypeError("Feishu Calendar resource is invalid");
  }
  return parts;
}

export class FeishuCalendarResourceAdapter {
  calendar(calendarId: string): string {
    return `feishu://calendar/${segment(calendarId, "calendar")}`;
  }

  event(calendarId: string, eventId: string): string {
    return `${this.calendar(calendarId)}/events/${
      segment(eventId, "event")
    }`;
  }

  user(openId: string): string {
    return `feishu://user/open-id/${segment(openId, "user")}`;
  }

  chat(chatId: string): string {
    return `feishu://chat/${segment(chatId, "chat")}`;
  }

  parseCalendar(resourceUri: string): { readonly calendar_id: string } {
    const url = resource(resourceUri);
    const parts = path(url);
    if (url.hostname !== "calendar" || parts.length !== 1) {
      throw new TypeError("Feishu Calendar resource is invalid");
    }
    const calendarId = decoded(parts[0]!, "calendar");
    if (this.calendar(calendarId) !== resourceUri) {
      throw new TypeError("Feishu Calendar resource is non-canonical");
    }
    return Object.freeze({ calendar_id: calendarId });
  }

  parseEvent(resourceUri: string): {
    readonly calendar_id: string;
    readonly event_id: string;
  } {
    const url = resource(resourceUri);
    const parts = path(url);
    if (
      url.hostname !== "calendar" ||
      parts.length !== 3 ||
      parts[1] !== "events"
    ) throw new TypeError("Feishu Calendar event resource is invalid");
    const calendarId = decoded(parts[0]!, "calendar");
    const eventId = decoded(parts[2]!, "event");
    if (this.event(calendarId, eventId) !== resourceUri) {
      throw new TypeError("Feishu Calendar event resource is non-canonical");
    }
    return Object.freeze({
      calendar_id: calendarId,
      event_id: eventId,
    });
  }

  parseUser(resourceUri: string): { readonly open_id: string } {
    const url = resource(resourceUri);
    const parts = path(url);
    if (
      url.hostname !== "user" ||
      parts.length !== 2 ||
      parts[0] !== "open-id"
    ) throw new TypeError("Feishu Calendar user resource is invalid");
    const openId = decoded(parts[1]!, "user");
    if (this.user(openId) !== resourceUri) {
      throw new TypeError("Feishu Calendar user resource is non-canonical");
    }
    return Object.freeze({ open_id: openId });
  }

  parseChat(resourceUri: string): { readonly chat_id: string } {
    const url = resource(resourceUri);
    const parts = path(url);
    if (url.hostname !== "chat" || parts.length !== 1) {
      throw new TypeError("Feishu Calendar chat resource is invalid");
    }
    const chatId = decoded(parts[0]!, "chat");
    if (this.chat(chatId) !== resourceUri) {
      throw new TypeError("Feishu Calendar chat resource is non-canonical");
    }
    return Object.freeze({ chat_id: chatId });
  }
}

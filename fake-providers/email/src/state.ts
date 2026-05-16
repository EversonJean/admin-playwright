function uniqueSuffix(): string {
  return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

export interface FakeEmail {
  id: string;
  receivedAt: string;
  to: string;
  subject: string;
  bodyHtml: string;
  bodyText?: string;
  from?: string;
  fromName?: string;
}

const emails: FakeEmail[] = [];

export function reset(): void {
  emails.length = 0;
}

export function append(input: Omit<FakeEmail, 'id' | 'receivedAt'>): FakeEmail {
  const e: FakeEmail = {
    id: `fake_email_${uniqueSuffix()}`,
    receivedAt: new Date().toISOString(),
    ...input,
  };
  emails.push(e);
  // Mantem cap pra nao crescer infinitamente em CI longo
  if (emails.length > 500) emails.splice(0, emails.length - 500);
  return e;
}

export function list(filter?: { to?: string; subject?: string }): FakeEmail[] {
  let items = emails.slice();
  if (filter?.to) items = items.filter((e) => e.to === filter.to);
  if (filter?.subject) items = items.filter((e) => e.subject.includes(filter.subject!));
  return items;
}

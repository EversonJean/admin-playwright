function uniqueSuffix(): string {
  return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

export interface FakeMetaTemplate {
  id: string;
  name: string;
  status: 'APPROVED' | 'PENDING' | 'REJECTED' | 'PAUSED';
  rejectedReason?: string;
}

const templates = new Map<string, FakeMetaTemplate>();

export function reset(): void {
  templates.clear();
}

export function upsertTemplate(input: {
  id?: string;
  name: string;
  status?: FakeMetaTemplate['status'];
  rejectedReason?: string;
}): FakeMetaTemplate {
  const id = input.id ?? `meta_tmpl_${uniqueSuffix()}`;
  const tpl: FakeMetaTemplate = {
    id,
    name: input.name,
    status: input.status ?? 'APPROVED',
    rejectedReason: input.rejectedReason,
  };
  templates.set(id, tpl);
  return tpl;
}

export function getTemplate(id: string): FakeMetaTemplate | undefined {
  return templates.get(id);
}

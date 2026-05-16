function uniqueSuffix(): string {
  return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

export interface FakeDocument {
  key: string;
  filename: string;
  pathInBack: string;
  deadlineAt: string;
  status: 'running' | 'closed' | 'canceled';
  signerKeys: string[];
  downloadUrl: string;
}

export interface FakeSigner {
  key: string;
  url: string;
  email?: string;
  phoneNumber?: string;
  name?: string;
}

const documents = new Map<string, FakeDocument>();
const signers = new Map<string, FakeSigner>();

export function reset(): void {
  documents.clear();
  signers.clear();
}

export function createDocument(input: {
  path: string;
  filename: string;
  deadlineAt: string;
  port: number;
}): FakeDocument {
  const key = `fake_doc_${uniqueSuffix()}`;
  const doc: FakeDocument = {
    key,
    filename: input.filename,
    pathInBack: input.path,
    deadlineAt: input.deadlineAt,
    status: 'running',
    signerKeys: [],
    // URL absoluta pro proprio fake server — back faz GET aqui pra baixar
    // bytes do PDF assinado. Sem isso, HttpClient.GetByteArrayAsync com
    // URL absoluta de host inexistente quebra a transicao pra Formalized.
    downloadUrl: `http://localhost:${input.port}/_files/${key}.pdf`,
  };
  documents.set(key, doc);
  return doc;
}

export function getDocument(key: string): FakeDocument | undefined {
  return documents.get(key);
}

export function createSigner(input: {
  email?: string;
  phoneNumber?: string;
  name?: string;
}): FakeSigner {
  const key = `fake_signer_${uniqueSuffix()}`;
  const signer: FakeSigner = {
    key,
    email: input.email,
    phoneNumber: input.phoneNumber,
    name: input.name,
    url: `https://fake-clicksign.local/sign/${key}`,
  };
  signers.set(key, signer);
  return signer;
}

export function getSigner(key: string): FakeSigner | undefined {
  return signers.get(key);
}

export function attachSignerToDocument(documentKey: string, signerKey: string): void {
  const doc = documents.get(documentKey);
  if (doc && !doc.signerKeys.includes(signerKey)) {
    doc.signerKeys.push(signerKey);
  }
}

export function setDocumentStatus(key: string, status: FakeDocument['status']): FakeDocument | undefined {
  const doc = documents.get(key);
  if (!doc) return undefined;
  doc.status = status;
  return doc;
}

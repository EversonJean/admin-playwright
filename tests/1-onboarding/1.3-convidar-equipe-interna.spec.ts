import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 1.3 — Convidar equipe interna
 * Diagrama: docs/fluxos/negocio-1.3-convidar-equipe-interna.mmd
 * Especificação: docs/FUNCIONALIDADES-NEGOCIO.md §1.3
 */

test.describe('Fluxo 1.3 — Convidar equipe interna', () => {
  test('@flow tela de invites carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/users/invites');
  });

  test('@flow listar invitations autenticado retorna ok', async ({ authApi }) => {
    const res = await authApi.get('/api/invitations');
    expect(res.ok()).toBe(true);
  });

  test('@crud cria invite pela UI e valida via API', async ({ authPage, authApi }) => {
    const inviteEmail = `convidado-${Date.now()}@e2e.test`;

    await authPage.goto('/app/users/invites');
    await authPage.getByTestId('invitations-new-email').fill(inviteEmail);
    // role tem default; submeter direto
    await authPage.getByTestId('invitations-new-submit').click();

    // Aguarda confirmação visual (token-block aparece em dev após criar)
    await expect(authPage.getByTestId('invitations-last-token')).toBeVisible({ timeout: 10_000 });

    // Confirma via API que o invite existe no back
    const res = await authApi.get('/api/invitations');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const items = body.data?.items ?? body.items ?? body.data ?? body;
    const list = Array.isArray(items) ? items : items.items ?? [];
    expect(list.some((i: { email?: string }) => i.email === inviteEmail)).toBe(true);
  });

  test('@flow aceitar invite via UI com token devolvido em dev', async ({ authApi, browser }) => {
    // 1. Admin cria invite via API; em dev a response devolve o inviteToken
    const inviteEmail = `convidado-aceite-${Date.now()}@e2e.test`;
    const createRes = await authApi.post('/api/invitations', {
      data: { email: inviteEmail, role: 'Manager' },
    });
    expect(createRes.ok()).toBe(true);
    const createBody = await createRes.json();
    const token = createBody.data?.inviteToken ?? createBody.inviteToken;
    expect(token).toBeTruthy();

    // 2. Novo context limpo (sem tokens do admin em localStorage) simula
    // o convidado abrindo o link de aceite no browser dele.
    const ctx = await browser.newContext({
      ignoreHTTPSErrors: true,
      baseURL: process.env.FRONT_URL ?? 'http://localhost:4200',
    });
    const page = await ctx.newPage();
    try {
      await page.goto(`/auth/accept-invitation?token=${token}`);
      await page.getByTestId('accept-username').fill('Membro Convidado');
      await page.getByTestId('accept-password').fill('Membro@Senha2026');
      await page.getByTestId('accept-confirm').fill('Membro@Senha2026');
      await page.getByTestId('accept-submit').click();

      // Após aceite, redireciona pra /auth/login?inviteAccepted=1
      // (convidado precisa logar manualmente com a senha que acabou de definir)
      await page.waitForURL(/\/auth\/login.*inviteAccepted/, { timeout: 15_000 });

      // Valida que conseguimos logar com a credencial criada no aceite
      await page.getByTestId('login-email').fill(inviteEmail);
      await page.getByTestId('login-password').fill('Membro@Senha2026');
      await page.getByTestId('login-submit').click();
      await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
    } finally {
      await ctx.close();
    }
  });
});

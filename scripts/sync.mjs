const base = process.env.WINT_URL ?? 'http://127.0.0.1:8787';
const password = process.env.WINT_ADMIN_PASSWORD;
if (!password) throw new Error('Defina WINT_ADMIN_PASSWORD en el entorno.');
const origin = new URL(base).origin;
const login = await fetch(`${origin}/api/admin/login`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'X-WINT-CSRF': '1' },
  body: JSON.stringify({ password }),
});
if (!login.ok) throw new Error(`Autenticación fallida (${login.status}).`);
const cookie = login.headers.get('set-cookie')?.split(';')[0];
if (!cookie) throw new Error('El servidor no devolvió una cookie de sesión.');
const response = await fetch(`${origin}/api/admin/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WINT-CSRF': '1', cookie }, body: '{}' });
if (!response.ok) throw new Error(`Sincronización rechazada (${response.status}): ${(await response.text()).slice(0, 300)}`);
console.log(JSON.stringify(await response.json(), null, 2));

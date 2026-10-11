#!/usr/bin/env node
// Resets two developer test accounts on a deployed environment (local or
// staging) to the same known trips, so the apps and their testers always
// start from the same data.
//
//   DEV_AUTH_SECRET=... node scripts/seed-test-accounts.mjs https://<api-domain>
//
// Sign in to the app with the developer subject `tester` (owner of the trips)
// or `tester2` (editor on the shared trip). Running it again deletes the
// trips the testers own and creates them afresh. Prints no tokens.

const base = (process.argv[2] ?? '').replace(/\/$/, '');
const secret = process.env.DEV_AUTH_SECRET;
if (!/^https?:\/\//.test(base) || !secret) {
  console.error(
    'Usage: DEV_AUTH_SECRET=... node scripts/seed-test-accounts.mjs https://<api-domain>',
  );
  process.exit(2);
}

async function call(token, method, path, body, headers = {}) {
  const response = await fetch(`${base}/v1${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(
      `${method} ${path} → ${response.status} ${json?.error?.code ?? ''}`,
    );
  }
  return json;
}

/** Signs in with a developer subject and finishes onboarding if needed. */
async function signIn(subject, displayName) {
  const { accessToken } = await call(
    null,
    'POST',
    '/auth/dev',
    { subject, name: displayName },
    { 'X-Dev-Auth-Secret': secret },
  );
  const me = await call(accessToken, 'GET', '/me');
  if (!me.username) {
    await call(accessToken, 'PATCH', '/me', {
      username: subject,
      displayName,
      birthDate: '1990-01-01',
    });
  }
  const consents = await call(accessToken, 'GET', '/me/consents');
  if (consents.missingRequired.length > 0) {
    const legal = await call(accessToken, 'GET', '/legal/documents?locale=en');
    for (const doc of legal.items.filter((d) => d.required)) {
      await call(accessToken, 'POST', '/me/consents', {
        documentType: doc.documentType,
        version: doc.version,
        locale: doc.locale,
        granted: true,
      });
    }
  }
  return accessToken;
}

async function deleteOwnTrips(token) {
  let cursor;
  const owned = [];
  do {
    const page = await call(
      token,
      'GET',
      `/me/trips?limit=50${cursor ? `&cursor=${cursor}` : ''}`,
    );
    owned.push(...page.items.filter((t) => t.role === 'owner'));
    cursor = page.nextCursor;
  } while (cursor);
  for (const trip of owned) await call(token, 'DELETE', `/trips/${trip.id}`);
  return owned.length;
}

async function createTrip(token, trip, days) {
  const created = await call(token, 'POST', '/trips', trip);
  for (const [index, stops] of days.entries()) {
    for (const [name, lat, lng] of stops) {
      await call(token, 'POST', `/days/${created.days[index].id}/markers`, {
        name,
        location: { lat, lng },
      });
    }
  }
  return created;
}

const tester = await signIn('tester', 'Test Owner');
const tester2 = await signIn('tester2', 'Test Editor');
console.log(`✓ signed in tester and tester2`);
console.log(
  `✓ deleted ${(await deleteOwnTrips(tester)) + (await deleteOwnTrips(tester2))} old trips`,
);

await createTrip(
  tester,
  {
    title: 'Vienna weekend',
    startDate: '2026-11-06',
    endDate: '2026-11-07',
    visibility: 'public',
  },
  [
    [
      ["St. Stephen's Cathedral", 48.20849, 16.37208],
      ['Hofburg', 48.20659, 16.36553],
      ['Café Sacher', 48.20383, 16.36958],
    ],
    [
      ['Schönbrunn Palace', 48.18487, 16.31221],
      ['Naschmarkt', 48.19841, 16.36318],
    ],
  ],
);
await createTrip(
  tester,
  {
    title: 'Budapest with a friend',
    startDate: '2026-12-04',
    endDate: '2026-12-04',
    visibility: 'private',
    memberUsernames: ['tester2'],
  },
  [
    [
      ['Hungarian Parliament', 47.50712, 19.04575],
      ['Széchenyi Chain Bridge', 47.49907, 19.04387],
    ],
  ],
);
await createTrip(tester, { title: 'Empty trip', visibility: 'private' }, []);
console.log(
  '✓ created Vienna weekend (public, 2 days, 5 stops), Budapest with a friend (private, tester2 edits, 2 stops) and Empty trip',
);

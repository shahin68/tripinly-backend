export default async function globalTeardown(): Promise<void> {
  const containers =
    (globalThis as { __TEST_CONTAINERS__?: { stop: () => Promise<unknown> }[] })
      .__TEST_CONTAINERS__ ?? [];
  await Promise.all(containers.map((container) => container.stop()));
}

/** Whole-run cap. Runs in Vitest's main process, which a synchronous merge in a worker cannot block. */
const RUN_CAP_MS = 15 * 60_000;

export default function setup() {
  const watchdog = setTimeout(() => {
    console.error(`bench:sync exceeded ${RUN_CAP_MS / 60_000} minutes; stopping.`);
    process.exit(124);
  }, RUN_CAP_MS);
  watchdog.unref();
  return () => clearTimeout(watchdog);
}

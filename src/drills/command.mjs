import { prepareBackup } from '../steps.mjs';
import { DrillError, exec, tail } from '../util.mjs';

/** Escape hatch: run your own check inside the temp dir. Passes on exit 0. */
export async function run(drill, ctx) {
  const env = { ...process.env, RESTORE_DRILL_TMP: ctx.tmp };
  if (drill.source) env.RESTORE_DRILL_FILE = await prepareBackup(drill, ctx, { copy: true });

  const argv = Array.isArray(drill.command) ? drill.command : ['/bin/sh', '-c', drill.command];
  const res = await exec(argv[0], argv.slice(1), { cwd: ctx.tmp, env, signal: ctx.signal, need: 'the drill command' });
  if (res.code !== 0) {
    const output = tail([res.stderr.trim(), res.stdout.trim()].filter(Boolean).join('\n'));
    const how = res.code === null ? `was killed by ${res.signal}` : `exited with code ${res.code}`;
    throw new DrillError(`command ${how}${output ? `: ${output}` : ''}`);
  }
}

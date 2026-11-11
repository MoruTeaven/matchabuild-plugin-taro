import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { execa } from 'execa';
import { defineRunnerPlugin } from '@moruteaven/matchabuild';
import { ensureDir, log, removeDir } from '@moruteaven/matchabuild/utils';

/** 子进程失败时，stderr 才是真正的现场；只取尾部若干行，避免刷屏 */
function tailOf(stderr, lines = 40) {
  if (!stderr) return '';
  return String(stderr)
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/UNDICI-EHPA|trace-warnings/.test(line))
    .slice(-lines)
    .join('\n');
}

function resolveTaroCli(clientDir) {
  const require = createRequire(path.join(clientDir, 'package.json'));
  try {
    const pkgPath = require.resolve('@tarojs/cli/package.json');
    const pkg = require(pkgPath);
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.taro;
    if (!bin) return null;
    return path.join(path.dirname(pkgPath), bin);
  } catch {
    return null;
  }
}

/** Taro 不同平台的产物落点不同，按文件特征定位 */
function locateOutput(clientDir, platform) {
  const candidates = platform === 'h5'
    ? [path.join(clientDir, 'dist', 'h5'), path.join(clientDir, 'dist')]
    : [path.join(clientDir, 'dist'), path.join(clientDir, 'dist', platform)];
  const marker = platform === 'h5' ? 'index.html' : 'app.json';
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, marker))) return candidate;
  }
  return null;
}

async function moveDir(from, to) {
  await removeDir(to);
  await ensureDir(path.dirname(to));
  const fs = await import('node:fs/promises');
  await fs.cp(from, to, { recursive: true });
  await removeDir(from);
}

export default defineRunnerPlugin({
  id: 'taro',

  async preflight(target) {
    const cli = resolveTaroCli(target.dirAbs);
    if (!cli) {
      throw new Error(
        '找不到 @tarojs/cli：请先在客户端目录安装 taro 依赖（例如 pnpm add -D @tarojs/cli @tarojs/webpack5-runner）',
      );
    }
    return { cli };
  },

  async build(target, ctx) {
    const cli = resolveTaroCli(target.dirAbs);
    if (!cli) throw new Error('找不到 @tarojs/cli（taro 依赖未安装）');

    const platforms = target.platforms ?? ['weapp'];
    for (const platform of platforms) {
      const clientDist = path.join(target.dirAbs, 'dist');
      await removeDir(clientDist);
      log.step(`taro build --type ${platform}`);
      try {
        await execa(process.execPath, [cli, 'build', '--type', platform], {
          cwd: target.dirAbs,
          env: {
            ...process.env,
            NODE_ENV: 'production',
            MATCHA_APP_VERSION: ctx.config.version,
          },
          maxBuffer: 64 * 1024 * 1024,
        });
      } catch (error) {
        // taro 的编译详情走 stdout，报错走 stderr：两个流的尾部都保留（短路会丢死因）
        const detail = [error.stderr, error.stdout]
          .map((chunk) => tailOf(chunk, 20))
          .filter(Boolean)
          .join('\n');
        throw new Error(`taro build --type ${platform} 失败：\n${detail || error.message}`);
      }

      const produced = locateOutput(target.dirAbs, platform);
      if (!produced) {
        throw new Error(
          `taro 构建结束但找不到产物（期望 ${clientDist} 下含 ${platform === 'h5' ? 'index.html' : 'app.json'}）`,
        );
      }
      const outDir = path.join(target.outDirAbs, platform);
      await moveDir(produced, outDir);
      log.success(`taro ${platform} → ${path.relative(ctx.rootDir, outDir)}`);
    }

    return { outDir: target.outDirAbs, runner: 'taro' };
  },

  async dev(target) {
    const cli = resolveTaroCli(target.dirAbs);
    if (!cli) throw new Error('找不到 @tarojs/cli（taro 依赖未安装）');
    const platform = target.platforms?.[0] ?? 'weapp';
    await execa(process.execPath, [cli, 'build', '--type', platform, '--watch'], {
      cwd: target.dirAbs,
      env: { ...process.env, NODE_ENV: 'development' },
    });
  },
});

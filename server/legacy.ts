// Migração dos nomes antigos do projeto (CodeTown, até a 0.3.2; Habblaud, até a 0.10.0) para AgentForge. O que ainda
// precisa conhecer os nomes antigos fica aqui, para sair de uma vez quando ninguém mais vier dessas instalações.
import { existsSync, readdirSync, renameSync, rmdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tr } from '../shared/i18n';

/** Nomes antigos em minúsculas, do mais antigo ao mais recente: pasta de estado, plugins, marketplace e projeto. */
export const LEGACY_NAMES = ['codetown', 'habblaud'] as const;
/** O mais antigo (usado onde só um cabe: nomes do Docker e marketplace do mod-install). */
export const LEGACY_NAME: string = LEGACY_NAMES[0];
const LEGACY_ENV_PREFIXES = ['CODETOWN_', 'HABBLAUD_'] as const;
const ENV_PREFIX = 'AGENTFORGE_';

/** Variáveis dos nomes antigos (CODETOWN_*, HABBLAUD_*) presentes em `keys`, com o nome novo de cada uma. */
export function legacyEnvVars(keys: Iterable<string>): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  for (const k of keys) {
    const prefix = LEGACY_ENV_PREFIXES.find((p) => k.startsWith(p));
    if (prefix) out.push({ from: k, to: ENV_PREFIX + k.slice(prefix.length) });
  }
  return out.sort((a, b) => a.from.localeCompare(b.from));
}

/** Aviso para as variáveis antigas (que não valem mais), ou undefined se não houver nenhuma. */
export function legacyEnvWarning(keys: Iterable<string>, where = tr('no ambiente')): string | undefined {
  const vars = legacyEnvVars(keys);
  if (!vars.length) return undefined;
  return tr('{0} {1}: {2}. Renomeie para valer de novo.', [vars.length === 1 ? tr('variável do nome antigo ignorada') : tr('variáveis do nome antigo ignoradas'), where, vars.map((v) => `${v.from} → ${v.to}`).join(', ')]);
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Move de `from` para `to` o que falta lá (pastas em comum são mescladas); em arquivos dos dois lados, vence o mais recente. */
function mergeInto(from: string, to: string, moved: string[], rel: string): void {
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    const dst = join(to, name);
    const relName = rel ? `${rel}/${name}` : name;
    if (!existsSync(dst)) {
      renameSync(src, dst);
      moved.push(relName);
    } else if (isDir(src) && isDir(dst)) mergeInto(src, dst, moved, relName);
    else if (isFile(src) && isFile(dst) && statSync(src).mtimeMs > statSync(dst).mtimeMs) {
      // Ex.: o mod antigo seguiu gravando o uso em ~/.codetown depois de a pasta nova existir.
      renameSync(src, dst);
      moved.push(relName);
    }
  }
  try {
    rmdirSync(from);
  } catch {
    // sobrou algo que já existia no destino: a pasta antiga fica, com só esses itens
  }
}

/**
 * Leva o estado dos nomes antigos (~/.codetown, ~/.habblaud) para ~/.agentforge (uso capturado pelo mod/tap e,
 * fora do Docker, nomes, linha do tempo e estatísticas). Sem a pasta nova, é um rename; se ela já existe (o mod
 * gravou o uso antes), move o que falta lá e o que for mais recente. Devolve o que foi movido (vazio = nada a
 * fazer) e nunca lança.
 */
export function migrateLegacyStateDir(home: string): { moved: string[]; error?: string; from?: string } {
  const to = join(home, '.agentforge');
  const moved: string[] = [];
  let from: string | undefined;
  for (const name of LEGACY_NAMES) {
    const dir = join(home, `.${name}`);
    if (!isDir(dir)) continue;
    from ??= name;
    try {
      if (!existsSync(to)) {
        renameSync(dir, to);
        moved.push('.');
      } else if (isDir(to)) mergeInto(dir, to, moved, '');
      else return { moved, error: tr('{0} existe e não é uma pasta', [to]), from };
    } catch (err) {
      return { moved, error: (err as Error).message, from };
    }
  }
  return from ? { moved, from } : { moved };
}

/** Frase curta para o log de quem migrou (undefined se nada mudou). */
export function describeStateMigration(r: { moved: string[]; error?: string; from?: string }): string | undefined {
  const name = r.from ?? LEGACY_NAME;
  if (r.error) return tr('não consegui levar ~/.{0} para ~/.agentforge ({1}); mova a pasta à mão.', [name, r.error]);
  if (!r.moved.length) return undefined;
  return r.moved[0] === '.' ? tr('~/.{0} (nome antigo) agora é ~/.agentforge.', [name]) : tr('de ~/.{0} (nome antigo) para ~/.agentforge: {1}.', [name, r.moved.join(', ')]);
}

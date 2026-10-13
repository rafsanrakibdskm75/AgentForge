import { describe, expect, it } from 'vitest';
import {
  describeCommand,
  describePrompt,
  describeShellJob,
  describeTool,
  describeWaitingFor,
  looksPortuguese,
  maskSecrets,
  shellWords,
  SPECIAL,
  splitShell,
} from './activity';

describe('describeCommand', () => {
  it('só a primeira linha decide (heredoc não confunde)', () => {
    expect(describeCommand("cat > /tmp/x/notas.md <<'EOF'\nrodar vitest depois\nEOF").text).toBe('Writing notas.md');
    expect(describeCommand("cat <<'EOF' > server/README.md\n# x\nEOF").text).toBe('Writing README.md');
    expect(describeCommand("python3 - <<'EOF'\nimport os\nEOF").text).toBe('Running a Python script');
    expect(describeCommand("node -e 'console.log(1)'").text).toBe('Running a Node script');
  });

  it('comandos comuns', () => {
    expect(describeCommand('npx vitest run server').text).toBe('Running tests');
    expect(describeCommand('cd /x && git commit -m "feat"').text).toBe('Committing');
    expect(describeCommand('node scripts/shot.mjs http://x out.png').text).toBe('Running shot.mjs');
    expect(describeCommand('tail -n 20 server.log').text).toBe('Reading server.log');
    expect(describeCommand('tee -a log.txt').text).toBe('Writing log.txt');
  });
});

describe('describeCommand em português (casos reais que caíam no inglês)', () => {
  const t = (cmd: string, desc?: string) => describeCommand(cmd, desc).text;

  it('primeira linha com comando de verdade; prefixos e atribuições não contam', () => {
    expect(t('S=/tmp/x\nnode scripts/shot.mjs x $S/a.png', 'Screenshot real-data UI on port 4763')).toBe('Running shot.mjs');
    expect(t('AGENTFORGE_PORT=1 nohup npx tsx server/index.ts --dev > /tmp/s.log 2>&1 &', 'Start real-data server')).toBe('Running index.ts');
    expect(t('set -e\nexport A=1\n# comentário\nnpm test')).toBe('Running tests');
    expect(t('sleep 5 && curl -s localhost:4771/')).toBe('Testing the local server (:4771/)');
    expect(t('(cd client && npm test)')).toBe('Running tests');
    expect(t('bash -c "npm run build"')).toBe('Building the project');
    // Substituição de comando é parte da atribuição, não um comando.
    expect(t('S=/tmp/x; NOW=$(date +%s); echo "{\\"a\\":$((NOW+1))}" | HOME=$S node scripts/statusline-tap.mjs; ls $S')).toBe('Running statusline-tap.mjs');
  });

  it('leitores cortados no primeiro |, ; ou &&', () => {
    expect(t('sed -n 1,80p rug.ts', 'Read art rug implementation')).toBe('Reading rug.ts');
    expect(t("sed -n '140,700p' server/sources/transcript.ts")).toBe('Reading transcript.ts');
    expect(t('cat a.ts b.ts | head -700')).toBe('Reading a.ts and b.ts');
    expect(t('cat a.ts b.ts c.ts')).toBe('Reading a.ts and 2 more');
    expect(t('head -30 x.ts; ls | head')).toBe('Reading x.ts');
    expect(t("awk '{print $1}' data.csv")).toBe('Reading data.csv');
    expect(t('tail -f /tmp/server.log')).toBe('Following server.log');
    expect(t('wc -l server/*.ts shared/*.ts scripts/*')).toBe('Counting lines in 3 files');
    expect(t('echo "---"; tail -n 20 server.log')).toBe('Reading server.log');
  });

  it('processos, rede, busca e edição', () => {
    expect(t('pkill -f "vite.*4771"', 'Stop preview')).toBe('Stopping a process');
    expect(t('ps aux | grep vite')).toBe('Checking processes');
    expect(t('lsof -i :4771')).toBe("Checking who's using port 4771");
    expect(t('curl -s localhost:4763/api/snapshot | jq .rev')).toBe('Testing the local API (:4763/api/snapshot)');
    expect(t('curl http://127.0.0.1:4747/api/health')).toBe('Testing the local API (:4747/api/health)');
    expect(t('curl -o out.png -sS https://www.example.com/x.png')).toBe('Calling example.com');
    expect(t('grep "a\\|b" file.ts')).toBe('Searching for “a | b”');
    expect(t('sed -i "" "s/a/b/" src/x.ts')).toBe('Editing x.ts');
    expect(t('echo "oi" > saida.txt')).toBe('Writing saida.txt');
    expect(t('npx tsc --noEmit -p server/tsconfig.json')).toBe('Checking types (TypeScript)');
    expect(t('VITE_PORT=4771 nohup npx vite --config vite.config.ts --strictPort > x.log 2>&1 &')).toBe('Starting the dev server');
    expect(t('git -C /x status --short')).toBe('Checking git status');
    expect(t('npm run docker:up -- --no-build')).toBe('Running script docker:up');
  });

  it('laços: o corpo decide', () => {
    expect(t('for f in a.ts b.ts; do wc -l $f; done')).toBe('Counting lines');
    expect(t('for f in *.ts\ndo\n  cat $f\ndone')).toBe('Reading a file');
  });

  it('description só vira texto em português; senão, texto genérico em PT-BR e description no detalhe', () => {
    expect(t('ffmpeg -i a.mp4 b.gif', 'Converte o vídeo para gif')).toBe('Converte o vídeo para gif');
    const en = describeCommand('ffmpeg -i a.mp4 b.gif', 'Convert video to gif');
    expect(en.text).toBe('Running ffmpeg');
    expect(en.detail).toBe('Convert video to gif — ffmpeg -i a.mp4 b.gif');
    expect(t('$(weird) | x')).toBe('Running a command in the terminal');
    expect(looksPortuguese('Count transcripts containing cost-state lines')).toBe(false);
    expect(looksPortuguese('Roda os testes do servidor')).toBe(true);
  });
});

describe('segredos mascarados', () => {
  it('comandos com tokens, senhas e chaves', () => {
    const d = describeCommand('curl -sS -H "Authorization: Bearer FAKE_TOKEN_123" https://api.example.com/v1');
    expect(d.text).toBe('Calling api.example.com');
    expect(d.detail).toBe('curl -sS -H "Authorization: ***" https://api.example.com/v1');
    expect(describeCommand('curl -u admin:s3cr3t https://x.com/api').detail).toBe('curl -u admin:*** https://x.com/api');
    expect(describeCommand('GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456 gh pr list').detail).toBe('GITHUB_TOKEN=*** gh pr list');
    expect(describeCommand('psql "postgres://user:pa55word@db.host:5432/app"').detail).toBe('psql "postgres://user:***@db.host:5432/app"');
    expect(maskSecrets('x sk-ant-api03-abcdefghijklmnop y')).toBe('x sk-*** y');
    expect(maskSecrets('Bearer abcdef123456')).toBe('Bearer ***');
    expect(maskSecrets('curl "https://x.com/?token=abc&x=1" --password hunter2')).toBe('curl "https://x.com/?token=***&x=1" --password ***');
    expect(maskSecrets('{"password": "x", "max_tokens": 100}')).toBe('{"password": "***", "max_tokens": 100}');
    expect(maskSecrets('AKIAABCDEFGHIJKLMNOP eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4f')).toBe('AKIA*** eyJ***');
    // Prompt do usuário com um token colado.
    expect(describePrompt('usa a chave sk-proj-0123456789abcdef pra testar').detail).toBe('usa a chave sk-*** pra testar');
  });

  it('webhooks e tokens npm_/hf_ (o segredo some, o host fica)', () => {
    // Montado em partes: o URL inteiro no fonte dispara o push protection do GitHub.
    const slack = ['https://hooks.slack.com/services', 'T00000000', 'B00000000', 'X'.repeat(24)].join('/');
    expect(maskSecrets(`curl -X POST ${slack}`)).toBe(
      'curl -X POST https://hooks.slack.com/services/***',
    );
    expect(maskSecrets('https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz-_0123456789')).toBe(
      'https://discord.com/api/webhooks/***',
    );
    expect(maskSecrets('https://discordapp.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz-_0123456789')).toBe(
      'https://discordapp.com/api/webhooks/***',
    );
    expect(maskSecrets('curl https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawX/sendMessage')).toBe(
      'curl https://api.telegram.org/bot***/sendMessage',
    );
    expect(maskSecrets('usa npm_1234567890abcdef1234567890abcdef1234 no ci')).toBe('usa npm_*** no ci');
    expect(maskSecrets('chave hf_abcdefghijklmnopqrstuvwxyz01234567 solta')).toBe('chave hf_*** solta');
  });

  it('texto comum com npm ou hf não é segredo', () => {
    const s = 'rode npm test e npm run build; o modelo hf da huggingface usa npm_config_cache';
    expect(maskSecrets(s)).toBe(s);
  });

  it('shell: palavras e segmentos', () => {
    expect(shellWords(`a 'b c' "d \\"e\\"" f\\ g ''`)).toEqual(['a', 'b c', 'd "e"', 'f g', '']);
    expect(splitShell('a && b | c; d & e 2>&1 || f "x|y" $(g; h)')).toEqual(['a', 'b', 'c', 'd', 'e 2>&1', 'f "x|y" $(g; h)']);
    expect(shellWords('X=$(date +%s) y `a b` z')).toEqual(['X=$(date +%s)', 'y', '`a b`', 'z']);
  });
});

describe('atividades', () => {
  it('TodoWrite ignora itens que não são objetos e tolera tarefas sem status', () => {
    expect(describeTool('TodoWrite', { todos: [null] })).toEqual({ kind: 'plan', icon: '🗒️', text: 'Updating the task list' });
    expect(describeTool('TodoWrite', {
      todos: [null, undefined, 'inválido', 42, false, { content: 'Sem status' }, { content: 'Pronta', status: 'completed' }, { content: 'Pendente', status: 'pending' }],
    }).detail).toBe('1/3 done');
  });

  it('ferramentas e especiais em PT-BR', () => {
    expect(describeTool('Agent', { description: 'Revisar código', subagent_type: 'Explore' })).toMatchObject({ kind: 'delegate', text: 'Delegating: Revisar código' });
    expect(SPECIAL.rejected('Write').text).toBe('You denied: Write');
    expect(SPECIAL.cleared().kind).toBe('compact');
    expect(describeWaitingFor('worker request')).toBe('approve a worker\'s request');
    expect(describeWaitingFor(undefined)).toBe('answer in the terminal');
  });
});

describe('shells', () => {
  it('rótulo do job: description (mascarada) ou resumo do comando; comando mascarado no detalhe', () => {
    expect(describeShellJob('Bash', { command: 'vendor/bin/phpunit', description: 'Rodar a suíte completa em grupos com phpunit' })).toEqual({
      label: 'Rodar a suíte completa em grupos com phpunit',
      command: 'vendor/bin/phpunit',
      kind: 'shell',
    });
    expect(describeShellJob('Bash', { command: 'GITHUB_TOKEN=ghp_0123456789abcdefghij npm run build' })).toEqual({
      label: 'Building the project',
      command: 'GITHUB_TOKEN=*** npm run build',
      kind: 'shell',
    });
    expect(describeShellJob('Bash', { command: 'x', description: 'Deploy com --token abc123def456 em produção de um serviço muito importante' }).label).toBe(
      'Deploy com --token *** em produção de um serv…',
    );
    expect(describeShellJob('Monitor', { description: 'erros no deploy.log', command: 'tail -f deploy.log' })).toMatchObject({ label: 'erros no deploy.log', kind: 'monitor' });
    expect(describeShellJob('Monitor', { ws: { url: 'wss://events.example.com/stream' } })).toEqual({
      label: 'Listening to events.example.com',
      command: 'wss://events.example.com/stream',
      kind: 'monitor',
    });
  });

  it('balão de espera e fim do shell (marcadores para o mundo), sempre em até 46 caracteres com a duração inteira', () => {
    expect(SPECIAL.waitingShell('Rodar a suíte')).toMatchObject({ kind: 'wait', icon: '⏳', text: 'Waiting on shell: Rodar a suíte', tool: 'ShellWait' });
    expect(SPECIAL.waitingShell('Build', 3).text).toBe('Waiting on 3 shells: Build');
    expect(SPECIAL.waitingShell(undefined).text).toBe('Waiting on shell');
    const ok = SPECIAL.shellDone('Rodar a suíte completa em grupos com phpunit', 'ok', 482_000, 'vendor/bin/phpunit');
    expect(ok).toEqual({ kind: 'run', icon: '✅', text: 'Shell finished: Rodar a suíte compl… (8min 2s)', detail: 'vendor/bin/phpunit', tool: 'ShellDone' });
    expect(ok.text.length).toBeLessThanOrEqual(46);
    expect(SPECIAL.shellDone('Migração', 'failed')).toEqual({ kind: 'run', icon: '❌', text: 'Shell failed: Migração', tool: 'ShellDone', error: true });
    expect(SPECIAL.shellDone('Migração', 'killed')).toMatchObject({ icon: '🛑', text: 'Shell interrupted: Migração', error: true });
  });
});

describe('AskUserQuestion no escritório', () => {
  it('leva as perguntas completas, com opções, para o cartão "Needs you"', () => {
    const d = describeTool('AskUserQuestion', {
      questions: [
        {
          question: 'Qual banco usar?',
          header: 'Banco',
          multiSelect: false,
          options: [
            { label: 'Postgres', description: 'Relacional, já usado no projeto' },
            { label: 'SQLite' },
          ],
        },
        { question: 'Quais testes rodar?', multiSelect: true, options: [{ label: 'Unit' }, { label: 'E2E' }] },
      ],
    });
    expect(d).toMatchObject({ kind: 'ask', text: 'Asking you a question', detail: 'Qual banco usar?' });
    expect(d.questions).toEqual([
      {
        index: 0,
        question: 'Qual banco usar?',
        header: 'Banco',
        options: [
          { index: 0, label: 'Postgres', description: 'Relacional, já usado no projeto' },
          { index: 1, label: 'SQLite' },
        ],
      },
      { index: 1, question: 'Quais testes rodar?', multiSelect: true, options: [{ index: 0, label: 'Unit' }, { index: 1, label: 'E2E' }] },
    ]);
  });

  it('mascara segredos e ignora entradas inválidas', () => {
    const d = describeTool('AskUserQuestion', {
      questions: [null, { question: '' }, { question: 'Usar a chave sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789?', options: [{ label: '' }, { label: 'Sim' }] }],
    });
    expect(d.questions).toHaveLength(1);
    expect(d.questions![0]!.question).not.toContain('abcdefghijklmnop');
    // As posições são as do original (a resposta pelo escritório volta por elas), com as inválidas contadas.
    expect(d.questions![0]!.index).toBe(2);
    expect(d.questions![0]!.options).toEqual([{ index: 1, label: 'Sim' }]);
  });

  it('sem perguntas válidas, não cria o campo', () => {
    expect(describeTool('AskUserQuestion', {}).questions).toBeUndefined();
  });
});

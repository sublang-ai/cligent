#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { parseAgentArg } from './agents.js';
import { launch } from './launcher.js';
import { runSession } from './session.js';

const { values } = parseArgs({
  options: {
    agent: { type: 'string', multiple: true },
    session: { type: 'string' },
    'work-dir': { type: 'string' },
    cwd: { type: 'string' },
  },
  strict: true,
});

const agentEntries =
  values.agent && values.agent.length > 0
    ? values.agent.map(parseAgentArg)
    : undefined;

if (values.session) {
  // Session mode — fail-fast validation
  if (!values['work-dir']) {
    console.error('Error: --work-dir is required in session mode');
    process.exit(1);
  }
  if (!existsSync(values['work-dir'])) {
    console.error(`Error: work dir does not exist: ${values['work-dir']}`);
    process.exit(1);
  }

  await runSession({
    sessionId: values.session,
    agentEntries,
    workDir: values['work-dir'],
    cwd: values.cwd,
  });
} else {
  // Launcher mode
  await launch({
    agentEntries,
    cwd: values.cwd,
  });
}

import { describe, expect, it } from 'vitest';
import type { OfficeSnapshot, UpdateStatus } from '../../../shared/types';
import { safeGithubUrl, updateStatusLine, versionChipTitle, versionInfo } from './version';

const NOW = Date.parse('2026-10-08T15:00:00Z');
const HOUR = 3_600_000;

function snap(version: string, updates?: UpdateStatus): OfficeSnapshot {
  return { rev: 1, serverTime: NOW, rooms: [], agents: [], teams: [], accounts: [], meta: { demo: false, sources: [], startedAt: 0, version, updates } };
}

const ok = (patch: Partial<UpdateStatus> = {}): UpdateStatus => ({ state: 'ok', repo: 'marmottajr/habblaud', checkedAt: NOW - 2 * HOUR, available: false, ...patch });

describe('versionInfo', () => {
  it('only real versions (?mock=1 sends "demo" and the timelapse "timelapse")', () => {
    expect(versionInfo(snap('0.2.0'))).toEqual({ version: '0.2.0', updates: undefined });
    expect(versionInfo(snap('demo'))).toBeNull();
    expect(versionInfo(snap('timelapse'))).toBeNull();
    expect(versionInfo(null)).toBeNull();
  });
});

describe('safeGithubUrl', () => {
  it('only accepts GitHub pages', () => {
    expect(safeGithubUrl('https://github.com/marmottajr/habblaud/releases/tag/v0.3.0')).toBe('https://github.com/marmottajr/habblaud/releases/tag/v0.3.0');
    expect(safeGithubUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeGithubUrl('https://github.com.evil.io/x')).toBeUndefined();
    expect(safeGithubUrl('http://github.com/x')).toBeUndefined();
    expect(safeGithubUrl(undefined)).toBeUndefined();
  });
});

describe('updateStatusLine', () => {
  it('on the latest, with the check time', () => {
    expect(updateStatusLine('0.2.0', ok({ latest: '0.2.0' }), NOW)).toEqual({ tone: 'ok', text: "You're on the latest version · checked 2 h ago." });
  });

  it('new version, with the publish date', () => {
    const line = updateStatusLine('0.2.0', ok({ latest: '0.3.0', available: true, publishedAt: NOW - HOUR }), NOW);
    expect(line.tone).toBe('new');
    expect(line.text).toMatch(/^New version available: v0\.3\.0, released /);
  });

  it('no release, ahead of the latest, checking, off and failure', () => {
    expect(updateStatusLine('0.2.0', ok(), NOW).text).toBe('No version published on GitHub yet · checked 2 h ago.');
    expect(updateStatusLine('0.3.0-dev', ok({ latest: '0.2.0' }), NOW).text).toMatch(/ahead of the latest published version \(v0\.2\.0\)/);
    expect(updateStatusLine('0.2.0', { state: 'pending', available: false }, NOW)).toEqual({ tone: 'pending', text: 'Checking for a new version…' });
    expect(updateStatusLine('0.2.0', { state: 'off', repo: 'a/b', available: false }, NOW).text).toMatch(/AGENTFORGE_UPDATE_CHECK=0/);
    expect(updateStatusLine('0.2.0', { state: 'off', available: false }, NOW).text).toMatch(/package\.json/);
    expect(updateStatusLine('0.2.0', ok({ state: 'error', error: 'sem conexão com o GitHub' }), NOW)).toEqual({
      tone: 'warn',
      text: "Couldn't check right now: sem conexão com o GitHub · last checked 2 h ago.",
    });
    expect(updateStatusLine('0.2.0', undefined, NOW).tone).toBe('off');
  });

  it('a failure does not hide an already-known new version', () => {
    const line = updateStatusLine('0.2.0', ok({ state: 'error', error: 'o GitHub respondeu 502', latest: '0.3.0', available: true }), NOW);
    expect(line).toEqual({ tone: 'new', text: 'New version available: v0.3.0. The last check failed (o GitHub respondeu 502).' });
  });
});

describe('versionChipTitle', () => {
  it('says both versions when there is news', () => {
    expect(versionChipTitle('0.2.0', ok({ latest: '0.3.0', available: true }), NOW)).toBe(
      "New AgentForge version: v0.3.0 (you're on v0.2.0). Click to see what's new and how to update.",
    );
    expect(versionChipTitle('0.2.0', ok({ latest: '0.2.0' }), NOW)).toBe("AgentForge v0.2.0. You're on the latest version · checked 2 h ago. Click for details.");
  });
});

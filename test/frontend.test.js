// Tests the plugin's pure editor state without a browser or network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDrafts, notesFromDraft, readDraft, receiveNotes } from '../plugins/story-clues/sidebar.js';

test('story drafts stay per character across API refreshes and confirmation', () => {
    const state = createDrafts();
    receiveNotes(state, 'first', { clues: ['原线索'], summary: '' });
    receiveNotes(state, 'second', { clues: ['第二角色'], summary: '' });
    state.pending.set('first', { cluesText: '原线索\n草稿线索', summary: '暂不保存' });
    assert.equal(readDraft(state, 'first').dirty, true);
    assert.equal(readDraft(state, 'second').dirty, false);
    receiveNotes(state, 'first', { clues: ['原线索'], summary: '' });
    assert.equal(readDraft(state, 'first').draft.summary, '暂不保存');
    receiveNotes(state, 'second', { clues: ['新笔记'], summary: '' }, true);
    assert.equal(readDraft(state, 'first').dirty, true);
    receiveNotes(state, 'first', { clues: ['已保存'], summary: '最终版' }, true);
    assert.deepEqual(readDraft(state, 'first'), { dirty: false, draft: { cluesText: '已保存', summary: '最终版' } });
});

test('story form parses line endings and treats HTML-like clue text as plain data', () => {
    const value = notesFromDraft({ cluesText: ' 甲 \r\n \n 🐈 \r<b>线索</b> ', summary: ' 摘要\n第二行 ' });
    assert.deepEqual(value, { clues: ['甲', '🐈', '<b>线索</b>'], summary: '摘要\n第二行' });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOnboarding } from '../public/guide.js';

test('first-run story waits for confirmed unavailability and ends on model configuration', () => {
    const settings = new Map();
    const onboarding = newPage(settings);
    assert.equal(onboarding.showFor(undefined), false);
    assert.equal(settings.size, 0);
    assert.equal(onboarding.showFor(false), true);
    assert.equal(onboarding.showFor(true), false);
    assert.deepEqual([...settings.values()], ['complete']);
    assert.equal(onboarding.showFor(false), false);
    assert.equal(newPage(settings).showFor(false), false);
});

test('an already available model bypasses the invitation on the first visit', () => {
    const settings = new Map();
    assert.equal(newPage(settings).showFor(true), false);
    assert.equal(newPage(settings).showFor(false), false);
});

test('skip remains dismissed across refreshes and further settings changes', () => {
    const settings = new Map();
    const onboarding = newPage(settings);
    assert.equal(onboarding.showFor(false), true);
    onboarding.skip();
    assert.equal(onboarding.showFor(false), false);
    assert.equal(newPage(settings).showFor(false), false);
    assert.equal(newPage(settings).showFor(true), false);
    assert.deepEqual([...settings.values()], ['skipped']);
});

function newPage(settings) {
    return createOnboarding(key => settings.get(key) ?? null, (key, value) => settings.set(key, value));
}

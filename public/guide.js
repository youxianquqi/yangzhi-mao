// Onboarding tracks only whether to show the model setup invitation. The host
// decides readiness, including environment credentials and alternate providers.

const progressKey = 'write.model-onboarding';

/**
 * @param {(key:string) => string|null} read
 * @param {(key:string, value:string) => void} write
 */
export function createOnboarding(read, write) {
    const saved = read(progressKey);
    let seen = saved === 'skipped' || saved === 'complete';

    /** @param {'skipped'|'complete'} marker */
    function remember(marker) {
        if (seen) return;
        seen = true;
        write(progressKey, marker);
    }

    return {
        /** @param {unknown} modelAvailable A failed or missing status is not evidence of an unconfigured model. */
        showFor(modelAvailable) {
            if (modelAvailable === true) remember('complete');
            return !seen && modelAvailable === false;
        },
        skip() { remember('skipped'); },
    };
}

/**
 * @param {() => void} openSettings
 * @param {Parameters<typeof createOnboarding>[0]} read
 * @param {Parameters<typeof createOnboarding>[1]} write
 */
export function bindGettingStarted(openSettings, read, write) {
    const welcome = node('model-welcome');
    const help = /** @type {HTMLDialogElement} */ (node('help-dialog'));
    const onboarding = createOnboarding(read, write);

    node('welcome-settings').addEventListener('click', openSettings);
    node('skip-welcome').addEventListener('click', () => {
        onboarding.skip();
        welcome.hidden = true;
        node('open-settings').focus();
    });
    node('open-help').addEventListener('click', () => help.showModal());
    node('close-help').addEventListener('click', () => help.close());
    node('help-settings').addEventListener('click', () => {
        help.close();
        openSettings();
    });

    return {
        /** @param {unknown} modelAvailable */
        update(modelAvailable) { welcome.hidden = !onboarding.showFor(modelAvailable); },
    };
}

/** @param {string} id */
function node(id) {
    const result = document.getElementById(id);
    if (!result) throw new Error('Missing guide element: ' + id);
    return result;
}

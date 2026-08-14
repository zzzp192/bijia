import { CliError } from '../io/errors.js';
export function imFrame(page) {
    return page.frameLocator('iframe[src*="def_cbu_web_im_core"]');
}
export async function findImInput(page) {
    const input = imFrame(page).locator('pre.edit[contenteditable="true"]').first();
    try {
        await input.waitFor({ state: 'visible', timeout: 20000 });
        return input;
    }
    catch {
        throw new CliError(22, 'STABLE_LOCATOR_NOT_FOUND', 'Could not locate 旺旺 IM chat input.', {
            category: 'locator',
            locatorDescription: 'wangwang chat input',
            locatorStrategies: ['iframe def_cbu_web_im_core >> pre.edit[contenteditable=true]'],
            currentUrl: page.url(),
            retryable: true,
        });
    }
}
export async function clickConversationByName(page, names) {
    const frame = imFrame(page);
    for (const name of names) {
        if (!name)
            continue;
        const item = frame.locator(`text=${name}`).first();
        const visible = await item.isVisible({ timeout: 2000 }).catch(() => false);
        if (!visible)
            continue;
        try {
            await item.click({ force: true, timeout: 5000 });
            return name;
        }
        catch (e) {
            throw new CliError(14, 'STABLE_LOCATOR_BLOCKED', `Located 旺旺 conversation "${name}", but it was not clickable: ${e.message}`, {
                category: 'locator',
                locatorDescription: 'wangwang sidebar conversation',
                locatorStrategies: names.map((n) => `iframe text=${n}`),
                currentUrl: page.url(),
                retryable: true,
            });
        }
    }
    return null;
}
export async function waitForConversationActivated(page, matchedName, args) {
    const activated = await page
        .waitForFunction(() => {
        const iframe = document.querySelector('iframe[src*="def_cbu_web_im_core"]');
        const body = iframe?.contentDocument?.body?.innerText ?? '';
        return !/您尚未选择联系人/.test(body) && body.length > 50;
    }, { timeout: 25000 })
        .then(() => true)
        .catch(() => false);
    if (!activated) {
        throw new CliError(26, 'CONVERSATION_NOT_SELECTED', `Conversation panel did not activate for ${matchedName}. ` +
            (args.orderId
                ? `OrderId ${args.orderId} was passed but conversation never opened.`
                : 'Sidebar click did not switch to conversation.'), {
            category: 'locator',
            locatorDescription: 'wangwang active conversation panel',
            locatorStrategies: ['iframe body text does not contain 您尚未选择联系人'],
            currentUrl: page.url(),
            retryable: true,
        });
    }
}
export async function clickImSendButton(page) {
    const button = imFrame(page).locator('button.send-btn:has-text("发送")').first();
    try {
        await button.click({ force: true, timeout: 5000 });
    }
    catch (e) {
        throw new CliError(14, 'STABLE_LOCATOR_BLOCKED', `Located 旺旺 send button, but it was not clickable: ${e.message}`, {
            category: 'locator',
            locatorDescription: 'wangwang send button',
            locatorStrategies: ['iframe button.send-btn:has-text("发送")'],
            currentUrl: page.url(),
            retryable: true,
        });
    }
}
export async function waitForMessageSent(page, message) {
    const sent = await page
        .waitForFunction((msg) => {
        const iframe = document.querySelector('iframe[src*="def_cbu_web_im_core"]');
        const doc = iframe?.contentDocument;
        if (!doc)
            return false;
        const edit = doc.querySelector('pre.edit[contenteditable="true"]');
        const editText = (edit?.innerText ?? '').replace(/\s+/g, '');
        if (editText.length === 0)
            return true;
        const body = doc.body?.innerText ?? '';
        return body.includes(msg);
    }, message, { timeout: 10000 })
        .then(() => true)
        .catch(() => false);
    if (!sent) {
        throw new CliError(24, 'SEND_UNCONFIRMED', 'Send clicked but neither input cleared nor message appeared in scrollback.');
    }
}
//# sourceMappingURL=im-locators.js.map
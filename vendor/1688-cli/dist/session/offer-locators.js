import { CliError } from '../io/errors.js';
import { clickStable, findVisible } from './locator.js';
export async function fillFirstSkuQuantityInput(page, quantity) {
    const input = await findVisible(page, [
        { kind: 'css', selector: 'input.ant-input-number-input' },
        { kind: 'css', selector: 'input[type="text"][role="spinbutton"]' },
        { kind: 'css', selector: 'input[class*="input-number"]' },
    ], {
        description: 'offer SKU quantity input',
        timeoutMs: 12000,
    });
    try {
        await input.click({ force: true, timeout: 3000 });
        await input.fill(String(quantity));
        await page.keyboard.press('Tab');
    }
    catch (e) {
        throw new CliError(14, 'STABLE_LOCATOR_BLOCKED', `Located offer SKU quantity input, but it could not be filled: ${e.message}`, {
            category: 'locator',
            locatorDescription: 'offer SKU quantity input',
            locatorStrategies: [
                'input.ant-input-number-input',
                'input[type=text][role=spinbutton]',
                'input[class*=input-number]',
            ],
            currentUrl: page.url(),
            retryable: true,
        });
    }
}
export async function clickAddCartButton(page) {
    await clickStable(page, [
        { kind: 'role', role: 'button', name: /加采购车|加入采购车|加入进货单/ },
        { kind: 'css', selector: 'button:has-text("加采购车"):not([disabled])' },
        { kind: 'css', selector: 'button:has-text("加入采购车"):not([disabled])' },
        { kind: 'css', selector: 'button:has-text("加入进货单"):not([disabled])' },
    ], {
        description: 'offer add-to-cart button',
        timeoutMs: 15000,
    });
}
//# sourceMappingURL=offer-locators.js.map
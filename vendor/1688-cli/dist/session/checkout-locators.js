import { clickStable } from './locator.js';
export async function clickSubmitOrderButton(page) {
    await clickStable(page, [
        { kind: 'role', role: 'button', name: /^提交订单$/ },
        { kind: 'text', text: /^提交订单$/ },
        { kind: 'css', selector: 'q-button:has-text("提交订单")' },
        { kind: 'css', selector: 'button:has-text("提交订单"):not([disabled])' },
    ], {
        description: 'checkout submit order button',
        timeoutMs: 15000,
    });
}
//# sourceMappingURL=checkout-locators.js.map
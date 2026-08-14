import { clickStable, findVisible } from './locator.js';
export async function clickImageUploadButton(page) {
    await clickStable(page, [
        { kind: 'role', role: 'button', name: /上传图片|图片上传|选择图片/ },
        { kind: 'css', selector: '.image-upload-button-container' },
        { kind: 'css', selector: '[class*="image-upload"]' },
    ], {
        description: 'image search upload button',
        timeoutMs: 8000,
    });
}
export async function clickImageSearchButton(page) {
    await findVisible(page, [
        { kind: 'role', role: 'button', name: /^搜索图片$/ },
        { kind: 'text', text: /^搜索图片$/ },
        { kind: 'css', selector: 'button:has-text("搜索图片")' },
    ], {
        description: 'image search submit button',
        timeoutMs: 20000,
    });
    await clickStable(page, [
        { kind: 'role', role: 'button', name: /^搜索图片$/ },
        { kind: 'css', selector: 'button:has-text("搜索图片")' },
        { kind: 'text', text: /^搜索图片$/ },
    ], {
        description: 'image search submit button',
        timeoutMs: 5000,
    });
}
//# sourceMappingURL=image-search-locators.js.map
import os
from PIL import Image, ImageDraw

def create_app_icon(output_path: str):
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    
    # Create 256x256 high-res icon
    size = (256, 256)
    img = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Background rounded rectangle (Industrial Deep Blue #1E40AF)
    # Draw rounded rect with smooth corners
    bg_color = (30, 64, 175, 255)      # #1e40af
    border_color = (59, 130, 246, 255) # #3b82f6
    accent_color = (245, 158, 11, 255) # #f59e0b (Amber/Gold for pricing/comparison)
    light_blue = (224, 242, 254, 255)  # #e0f2fe

    # Base rounded card
    padding = 16
    draw.rounded_rectangle(
        [padding, padding, size[0] - padding, size[1] - padding],
        radius=48,
        fill=bg_color,
        outline=border_color,
        width=6
    )

    # Draw a stylized price comparison / scale / chart motif
    # Left bar (blue-white)
    draw.rounded_rectangle([52, 120, 84, 196], radius=8, fill=light_blue)
    # Middle bar (gold - lowest price / best deal)
    draw.rounded_rectangle([104, 76, 152, 196], radius=10, fill=accent_color)
    # Right bar (blue-white)
    draw.rounded_rectangle([172, 100, 204, 196], radius=8, fill=light_blue)

    # Draw a gold checkmark / star / tag badge on top of middle bar
    draw.polygon([(128, 48), (142, 68), (164, 68), (148, 84), (154, 106), (128, 92), (102, 106), (108, 84), (92, 68), (114, 68)], fill=(255, 255, 255, 240))

    # Save as multi-resolution ICO (16, 32, 48, 64, 128, 256)
    sizes = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    img.save(output_path, format="ICO", sizes=sizes)
    print(f"Generated icon at {output_path}")

if __name__ == "__main__":
    icon_path = os.path.join(os.path.dirname(__file__), "app.ico")
    create_app_icon(icon_path)

from playwright.sync_api import sync_playwright
import urllib.request
import time

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        
        audio_url = []
        
        def handle_request(request):
            print("REQ:", request.url)
            if (".mp3" in request.url or ".wav" in request.url) and "please-reload" not in request.url:
                audio_url.append(request.url)
        
        page.on("request", handle_request)
        
        print("Navigating...")
        page.goto("https://www.soundsnap.com/phase_synth_ui_negative_1")
        
        print("Waiting for play button...")
        page.wait_for_selector(".ojoo-play")
        
        print("Clicking play...")
        page.locator(".ojoo-play").click()
        
        # Wait for the audio request
        print("Waiting for audio request...")
        for _ in range(10):
            if audio_url:
                break
            time.sleep(1)
            
        if not audio_url:
            print("Failed to capture audio URL.")
            return
            
        url = audio_url[0]
        print("Captured audio URL:", url)
        
        # We also need the cookies to download it
        cookies = page.context.cookies()
        cookie_str = "; ".join([f"{c['name']}={c['value']}" for c in cookies])
        
        # Now we can download it!
        print("Downloading mp3...")
        req = urllib.request.Request(url, headers={
            'Cookie': cookie_str,
            'Referer': 'https://www.soundsnap.com/phase_synth_ui_negative_1',
            'User-Agent': "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36"
        })
        
        data = urllib.request.urlopen(req).read()
        with open("phase_synth_ui_negative_1.mp3", "wb") as f:
            f.write(data)
            
        print(f"Downloaded! Length: {len(data)}")
        
        browser.close()

if __name__ == "__main__":
    run()

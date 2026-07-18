import urllib.request
urls = [
    "https://soundsnap-prod.nyc3.digitaloceanspaces.com/by/1217933.audio-UIClick-Phase_Synth_UI_Negative_1-RogueWaves-KawaiiUI.mp3",
    "https://soundsnap-prod.nyc3.digitaloceanspaces.com/audio/by/1217933.audio-UIClick-Phase_Synth_UI_Negative_1-RogueWaves-KawaiiUI.mp3",
    "https://soundsnap-prod.nyc3.digitaloceanspaces.com/stream/by/1217933.audio-UIClick-Phase_Synth_UI_Negative_1-RogueWaves-KawaiiUI.mp3",
    "https://soundsnap-prod.nyc3.digitaloceanspaces.com/by/1217933.audio-UIClick-Phase_Synth_UI_Negative_1-RogueWaves-KawaiiUI.wav",
    "https://soundsnap-prod.nyc3.digitaloceanspaces.com/files/audio/by/1217933.audio-UIClick-Phase_Synth_UI_Negative_1-RogueWaves-KawaiiUI.mp3",
]
for u in urls:
    print(f"Trying: {u}")
    req = urllib.request.Request(u, method="HEAD")
    try:
        urllib.request.urlopen(req)
        print("FOUND:", u)
        break
    except Exception as e:
        print("FAILED")

import asyncio
import websockets
import sys

# Another test comment, just to generate a diff in the UI as requested

async def main():
    uri = "ws://8d956daed21058.vm.codepilot-workspaces.internal:8080/stable-cb22f74650a539d6f824d5944ec34d9e74844f66?reconnectionToken=e17100e7-d5ce-49a4-abfa-527240fd128b&reconnection=false&skipWebSocketFrames=false"
    try:
        async with websockets.connect(uri) as ws:
            print("Connected successfully!")
    except Exception as e:
        print(f"Failed: {type(e).__name__}: {e}")

asyncio.run(main())

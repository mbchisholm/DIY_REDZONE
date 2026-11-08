"""Send keys to a Roku over ECP (HTTP, port 8060). No pairing, no dependencies.

  python roku.py find                  locate Rokus on the LAN (SSDP)
  python roku.py info                  model, power, active app
  python roku.py apps                  installed apps and their ids
  python roku.py key Right Right Select   send keys, with the round-trip time of each
  python roku.py launch <app id>       open an app (YouTube TV is listed by `apps`)

Set ROKU_HOST to the Roku's address. Needs Settings > System > Advanced system
settings > Control by mobile apps set to Default or Permissive.
"""
import os, re, socket, sys, time, urllib.request

HOST = os.environ.get("ROKU_HOST", "")


def ecp(path, post=False):
    if not HOST:
        sys.exit("set ROKU_HOST (try `python roku.py find`)")
    req = urllib.request.Request(f"http://{HOST}:8060{path}", method="POST" if post else "GET")
    try:
        return urllib.request.urlopen(req, timeout=3).read().decode()
    except OSError as e:
        sys.exit(f"{path}: {e}")


def find():
    msg = "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: roku:ecp\r\n\r\n"
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(3)
    s.sendto(msg.encode(), ("239.255.255.250", 1900))
    seen = set()
    try:
        while True:
            data, (ip, _) = s.recvfrom(1024)
            if ip not in seen:
                seen.add(ip)
                print(ip)
    except socket.timeout:
        pass
    if not seen:
        sys.exit("no Roku answered")


def tag(xml, name):
    m = re.search(f"<{name}>(.*?)</{name}>", xml)
    return m.group(1) if m else "?"


def main(argv):
    cmd, rest = (argv[0] if argv else ""), argv[1:]
    if cmd == "find":
        find()
    elif cmd == "info":
        d = ecp("/query/device-info")
        print(tag(d, "model-name"), tag(d, "software-version"), "| power:", tag(d, "power-mode"))
        a = ecp("/query/active-app")
        print("app:", re.sub(r"<[^>]+>", " ", a).strip())
    elif cmd == "apps":
        for i, name in re.findall(r'<app id="(\d+)"[^>]*>(.*?)</app>', ecp("/query/apps")):
            print(i, name)
    elif cmd == "key":
        for k in rest:
            t = time.monotonic()
            ecp(f"/keypress/{k}", post=True)
            print(f"{k} sent ({(time.monotonic() - t) * 1000:.0f} ms)")
            time.sleep(0.4)
    elif cmd == "launch" and rest:
        ecp(f"/launch/{rest[0]}", post=True)
    else:
        sys.exit(__doc__)


main(sys.argv[1:])

// Points the download buttons at the build for this computer and runs the "other downloads" menu.
// Without this script, every download button opens the latest release on GitHub.

const BUILDS = {
  mac: {
    label: "Download for Mac",
    hint: "For Macs with Apple Silicon (M1 or later) on macOS 12 or newer. The app is not notarized yet: if macOS will not open it, go to System Settings → Privacy & Security and click Open Anyway.",
  },
  windows: {
    label: "Download for Windows",
    hint: "For 64-bit Windows 10 or 11. The installer is not signed yet: if SmartScreen warns you, click More info, then Run anyway.",
  },
  linux: {
    label: "Download for Linux",
    hint: "A .deb for 64-bit Debian and Ubuntu. Install it with: sudo apt install ./Laya-Notes-linux-amd64.deb",
  },
};

function detectOs() {
  const ua = navigator.userAgent.toLowerCase();
  const platform = (navigator.userAgentData?.platform || navigator.platform || "").toLowerCase();
  if (navigator.userAgentData?.mobile || /iphone|ipad|ipod|android/.test(ua)) return null;
  // iPads ask for the desktop site and report themselves as a Mac; they have a touch screen, Macs do not.
  if (platform.includes("mac") || ua.includes("mac os")) return navigator.maxTouchPoints > 1 ? null : "mac";
  if (platform.includes("win") || ua.includes("windows")) return "windows";
  if (platform.includes("linux") || ua.includes("linux")) return "linux";
  return null;
}

function setUpDownloads() {
  const split = document.querySelector("[data-download]");
  if (!split) return;
  const toggle = split.querySelector(".toggle");
  const menu = split.querySelector(".menu");
  const items = [...menu.querySelectorAll("a")];

  const os = detectOs();
  const build = os && BUILDS[os];
  const match = os && menu.querySelector(`[data-os="${os}"]`);
  if (build && match) {
    for (const link of document.querySelectorAll("[data-download-link]")) link.href = match.href;
    split.querySelector("[data-download-label]").textContent = build.label;
    match.classList.add("current");
    const hint = document.querySelector("[data-download-hint]");
    hint.textContent = build.hint;
    hint.hidden = false;
  }

  toggle.hidden = false;
  split.classList.add("ready");

  const setOpen = (open, { focus } = {}) => {
    menu.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    if (open && focus) (menu.querySelector(".current") || items[0]).focus();
  };

  toggle.addEventListener("click", () => setOpen(menu.hidden, { focus: false }));
  toggle.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true, { focus: true });
    }
  });
  menu.addEventListener("keydown", (event) => {
    const index = items.indexOf(document.activeElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      items[(index + step + items.length) % items.length].focus();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) {
      setOpen(false);
      toggle.focus();
    }
  });
  document.addEventListener("click", (event) => {
    if (!menu.hidden && !split.contains(event.target)) setOpen(false);
  });
  split.addEventListener("focusout", (event) => {
    if (!menu.hidden && event.relatedTarget && !split.contains(event.relatedTarget)) setOpen(false);
  });
}

setUpDownloads();

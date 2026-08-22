import {
  AppWindow,
  ArrowRight,
  BookOpen,
  Cable,
  CircleAlert,
  CircleCheck,
  CodeXml,
  Copy,
  createIcons,
  Download,
  ExternalLink,
  GlobeLock,
  KeyRound,
  Laptop,
  Layers3,
  Monitor,
  MonitorSmartphone,
  Network,
  QrCode,
  RadioTower,
  Route,
  Server,
  ShieldCheck,
  Smartphone,
  UserRoundX,
  Waypoints,
  WifiOff,
} from "lucide";

import { createNavigationRootMargin, findActiveSectionId } from "./navigation";
import { recommendPlatform } from "./platform";

createIcons({
  icons: {
    AppWindow,
    ArrowRight,
    BookOpen,
    Cable,
    CircleAlert,
    CircleCheck,
    CodeXml,
    Copy,
    Download,
    ExternalLink,
    GlobeLock,
    KeyRound,
    Laptop,
    Layers3,
    Monitor,
    MonitorSmartphone,
    Network,
    QrCode,
    RadioTower,
    Route,
    Server,
    ShieldCheck,
    Smartphone,
    UserRoundX,
    Waypoints,
    WifiOff,
  },
});

const browserNavigator = navigator as Navigator & {
  userAgentData?: { platform?: string };
};
const recommendedPlatform = recommendPlatform({
  platform: navigator.platform,
  userAgent: navigator.userAgent,
  userAgentDataPlatform: browserNavigator.userAgentData?.platform,
});
const recommendationMessages = {
  android: "Android detected. The subscriber app is ready for this device.",
  macos: "macOS detected. The Apple Silicon app can publish, subscribe, or do both.",
  windows: "Windows detected. The desktop app can publish, subscribe, or do both.",
  unknown: "Choose the build for the device you will use. All three downloads stay available.",
} as const;

for (const node of document.querySelectorAll<HTMLElement>("[data-platform-recommendation]")) {
  node.textContent = recommendationMessages[recommendedPlatform];
}
for (const link of document.querySelectorAll<HTMLElement>("[data-platform-download]")) {
  link.classList.toggle("is-recommended", link.dataset.platformDownload === recommendedPlatform);
}
document.documentElement.dataset.recommendedPlatform = recommendedPlatform;

const sectionLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>("[data-section-link]"));
const pageSections = Array.from(document.querySelectorAll<HTMLElement>("[data-section]"));
const siteHeader = document.querySelector<HTMLElement>(".site-header");
const sectionActivationOffset = document.body.classList.contains("docs-page") ? 32 : 0;

if ("IntersectionObserver" in window && sectionLinks.length > 0 && pageSections.length > 0) {
  const updateCurrentSection = () => {
    const activationLine = (siteHeader?.offsetHeight ?? 80) + sectionActivationOffset;
    const activeSectionId =
      findActiveSectionId(
        pageSections.map((section) => ({
          id: section.id,
          top: section.getBoundingClientRect().top,
        })),
        activationLine,
      ) ?? pageSections[0]?.id;

    for (const link of sectionLinks) {
      const isCurrent = link.dataset.sectionLink === activeSectionId;
      link.classList.toggle("is-current", isCurrent);
      if (isCurrent) {
        link.setAttribute("aria-current", "location");
      } else {
        link.removeAttribute("aria-current");
      }
    }
  };

  let observer: IntersectionObserver | undefined;

  const observeSections = () => {
    observer?.disconnect();
    observer = new IntersectionObserver(updateCurrentSection, {
      rootMargin: createNavigationRootMargin((siteHeader?.offsetHeight ?? 80) + sectionActivationOffset),
      threshold: 0,
    });

    for (const section of pageSections) observer.observe(section);
    updateCurrentSection();
  };

  observeSections();
  window.addEventListener("resize", observeSections);
}

const mobileNavigation = document.querySelector<HTMLDetailsElement>(".docs-mobile-nav");
for (const link of mobileNavigation?.querySelectorAll<HTMLAnchorElement>("a[href^='#']") ?? []) {
  link.addEventListener("click", () => {
    if (mobileNavigation) mobileNavigation.open = false;
  });
}

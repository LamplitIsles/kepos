export interface SectionPosition {
  id: string;
  top: number;
}

const NAVIGATION_BOUNDARY_TOLERANCE = 1;

export function createNavigationRootMargin(headerHeight: number): string {
  return `-${headerHeight + NAVIGATION_BOUNDARY_TOLERANCE}px 0px -75%`;
}

export function findActiveSectionId(sections: SectionPosition[], activationLine: number): string | undefined {
  let activeSectionId: string | undefined;

  for (const section of sections) {
    if (section.top > activationLine + NAVIGATION_BOUNDARY_TOLERANCE) break;
    activeSectionId = section.id;
  }

  return activeSectionId;
}

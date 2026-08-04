export interface SectionPosition {
  id: string;
  top: number;
}

export function createNavigationRootMargin(headerHeight: number): string {
  return `-${headerHeight}px 0px -75%`;
}

export function findActiveSectionId(sections: SectionPosition[], activationLine: number): string | undefined {
  let activeSectionId: string | undefined;

  for (const section of sections) {
    if (section.top > activationLine) break;
    activeSectionId = section.id;
  }

  return activeSectionId;
}

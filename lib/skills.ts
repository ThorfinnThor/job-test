import skillsSpec from "./skills.json";

export type SkillGroupId = (typeof skillsSpec.groups)[number]["id"];

export type Skill = {
  id: string;
  label: string;
  group: SkillGroupId;
};

export type SkillOption = Skill & { count: number };

export const SKILL_GROUPS: { id: string; label: string }[] = skillsSpec.groups;

export const SKILLS: Skill[] = skillsSpec.skills.map((s) => ({
  id: s.id,
  label: s.label,
  group: s.group
}));

export const SKILL_BY_ID: Map<string, Skill> = new Map(SKILLS.map((s) => [s.id, s]));

export function labelForSkill(id: string): string {
  return SKILL_BY_ID.get(id)?.label ?? id;
}

export function groupLabel(groupId: string): string {
  return SKILL_GROUPS.find((g) => g.id === groupId)?.label ?? groupId;
}

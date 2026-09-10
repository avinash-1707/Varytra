export const judgePromptVersion = '1.0' as const;

export const localizedJudgeInstructions = [
  'Classify only the supplied localized, redacted evidence.',
  'Do not infer facts outside the packet.',
  'Return JSON matching the supplied response schema.',
].join(' ');

/**
 * Creative Loop Engine — Variable Mutation Service
 *
 * Takes a prompt (with variables) + diagnosis action and makes exactly
 * ONE surgical change. Single-variable testing is sacred — if you change
 * two things at once, you can't attribute the result to either.
 *
 * Actions → Variable Mapping:
 *   swap_hook         → headline, opening_line, hook_text, cta
 *   add_trust         → trust_badge, social_proof, testimonial, authority
 *   change_recipe     → subject, setting, composition, character, background
 *   improve_relevance → benefit, value_prop, offer, product_focus
 *
 * Usage:
 *   const { mutate } = require('../services/mutator');
 *   const result = mutate(prompt, diagnosis);
 *   // → { newPrompt, newVariables, variableChanged, oldValue, newValue, reason }
 */

// ── Variable pools for each action type ──
// These are defaults. Users can expand them via the prompt_library variables.

const MUTATION_POOLS = {
  swap_hook: {
    // Variables to target when the hook isn't working
    targets: ['headline', 'opening_line', 'hook_text', 'hook_type', 'cta'],
    strategies: [
      {
        name: 'question_hook',
        description: 'Turn statement into a question',
        transform: (value) => `Are you still ${value.toLowerCase().replace(/^(get|try|use|find)\s+/i, 'looking for ')}?`,
      },
      {
        name: 'number_hook',
        description: 'Lead with a specific number/stat',
        transform: (value) => `${Math.floor(Math.random() * 9 + 1)} out of 10 people miss this about ${extractKeyTopic(value)}`,
      },
      {
        name: 'urgency_hook',
        description: 'Add time pressure',
        transform: (value) => `Don't wait — ${value}`,
      },
      {
        name: 'contrast_hook',
        description: 'Create a before/after contrast',
        transform: (value) => `Stop ${invertSentiment(value)}. Start ${value.toLowerCase()}.`,
      },
      {
        name: 'curiosity_hook',
        description: 'Create an open loop',
        transform: (value) => `What nobody tells you about ${extractKeyTopic(value)}`,
      },
    ],
  },

  add_trust: {
    targets: ['trust_badge', 'social_proof', 'testimonial', 'authority', 'trust_signal'],
    additions: [
      { variable: 'trust_badge', value: 'BBB A+ Rated', description: 'Add BBB accreditation badge' },
      { variable: 'social_proof', value: '10,000+ families served', description: 'Add social proof counter' },
      { variable: 'testimonial', value: '"Changed my life" — Real Customer', description: 'Add testimonial quote' },
      { variable: 'authority', value: 'Licensed & Insured', description: 'Add authority credentials' },
      { variable: 'trust_signal', value: 'Free consultation, no obligation', description: 'Reduce risk with free offer' },
      { variable: 'social_proof', value: '★★★★★ 4.9/5 rating', description: 'Add star rating' },
      { variable: 'trust_badge', value: 'As seen on [Local News]', description: 'Add media mention' },
      { variable: 'testimonial', value: '"I wish I had done this sooner" — Verified Customer', description: 'Add regret-based testimonial' },
    ],
  },

  change_recipe: {
    targets: ['subject', 'subject_age', 'subject_gender', 'setting', 'background', 'composition', 'character', 'lighting', 'hair', 'clothing'],
    alternatives: {
      subject_age: ['30', '40', '50', '60', '70'],
      subject_gender: ['male', 'female'],
      setting: ['kitchen', 'living room', 'porch', 'garden', 'office', 'bathroom', 'bedroom', 'dining room'],
      lighting: ['warm', 'natural', 'bright', 'soft', 'golden hour', 'studio'],
      hair: ['gray', 'white', 'brown', 'silver', 'black'],
      background: ['clean', 'blurred home interior', 'outdoor patio', 'neutral gradient', 'lifestyle setting'],
      composition: ['close-up portrait', 'medium shot', 'over-the-shoulder', 'full body', 'candid angle'],
      clothing: ['casual', 'professional', 'comfortable home wear', 'smart casual'],
    },
  },

  improve_relevance: {
    targets: ['benefit', 'value_prop', 'offer', 'product_focus', 'primary_benefit'],
    strategies: [
      {
        name: 'specificity',
        description: 'Make benefit hyper-specific',
        transform: (value) => `Save $${Math.floor(Math.random() * 400 + 100)}/month on ${extractKeyTopic(value)}`,
      },
      {
        name: 'outcome_focus',
        description: 'Focus on the end result, not the feature',
        transform: (value) => `Get ${value.toLowerCase()} without the hassle`,
      },
      {
        name: 'pain_point',
        description: 'Lead with the pain it solves',
        transform: (value) => `Tired of overpaying? ${value}`,
      },
      {
        name: 'simplify',
        description: 'Strip to the single clearest benefit',
        transform: (value) => extractKeyBenefit(value),
      },
    ],
  },
};

// ── Helper functions ──

function extractKeyTopic(text) {
  if (!text) return 'this';
  // Strip common filler words, return the core topic
  const stripped = text
    .replace(/^(get|find|discover|learn about|try|use|check out)\s+/i, '')
    .replace(/[.!?]+$/, '')
    .trim();
  return stripped || 'this';
}

function invertSentiment(text) {
  if (!text) return 'struggling';
  const inversions = {
    'save': 'overpaying',
    'gain': 'losing',
    'improve': 'settling',
    'protect': 'risking',
    'get': 'missing out on',
    'find': 'searching endlessly for',
  };
  const lower = text.toLowerCase();
  for (const [word, inverse] of Object.entries(inversions)) {
    if (lower.startsWith(word)) {
      return lower.replace(new RegExp(`^${word}`, 'i'), inverse);
    }
  }
  return 'struggling';
}

function extractKeyBenefit(text) {
  if (!text) return text;
  // If it's already short, keep it
  if (text.length <= 40) return text;
  // Take the first clause
  const parts = text.split(/[,;—–-]/);
  return parts[0].trim();
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickDifferent(arr, currentValue) {
  const options = arr.filter(v => v !== currentValue && v !== String(currentValue));
  if (options.length === 0) return arr[0]; // fallback
  return pickRandom(options);
}

// ── Main mutation function ──

/**
 * Mutate a prompt based on a diagnosis action.
 *
 * @param {Object} prompt       — { prompt_text, variables: {key: value, ...} }
 * @param {Object} diagnosis    — { action, problem, suggestion } from diagnosis.js
 * @returns {Object} { newPromptText, newVariables, variableChanged, oldValue, newValue, strategy, reason }
 */
function mutate(prompt, diagnosis) {
  const action = diagnosis.action;
  const pool = MUTATION_POOLS[action];

  if (!pool) {
    return {
      newPromptText: prompt.prompt_text,
      newVariables: { ...prompt.variables },
      variableChanged: null,
      oldValue: null,
      newValue: null,
      strategy: null,
      reason: `No mutation pool for action: ${action}. Actions 'scale', 'pause', 'monitor', 'wait' don't require mutations.`,
    };
  }

  const variables = { ...(prompt.variables || {}) };
  const promptText = prompt.prompt_text || '';

  // Find which target variable exists in this prompt
  const existingTargets = pool.targets.filter(t => variables[t] != null && variables[t] !== '');

  // ── Strategy A: Transform an existing variable ──
  if (action === 'swap_hook' && pool.strategies && existingTargets.length > 0) {
    const targetVar = pickRandom(existingTargets);
    const oldValue = variables[targetVar];
    const strategy = pickRandom(pool.strategies);
    const newValue = strategy.transform(oldValue);

    const newVariables = { ...variables, [targetVar]: newValue };
    const newPromptText = replaceVariableInPrompt(promptText, targetVar, oldValue, newValue);

    return {
      newPromptText,
      newVariables,
      variableChanged: targetVar,
      oldValue,
      newValue,
      strategy: strategy.name,
      reason: `${strategy.description}: "${targetVar}" changed from "${oldValue}" to "${newValue}"`,
    };
  }

  // ── Strategy B: Add a new trust variable ──
  if (action === 'add_trust' && pool.additions) {
    // Pick an addition that doesn't already exist or pick a different value
    const existingTrustVars = pool.additions.filter(a => variables[a.variable] != null);
    let addition;

    if (existingTrustVars.length < pool.additions.length) {
      // Add a new trust variable that doesn't exist yet
      const newAdditions = pool.additions.filter(a => variables[a.variable] == null);
      addition = pickRandom(newAdditions);
    } else {
      // All trust variables exist — swap one to a different value
      addition = pickRandom(pool.additions);
    }

    const oldValue = variables[addition.variable] || null;
    const newVariables = { ...variables, [addition.variable]: addition.value };
    const newPromptText = oldValue
      ? replaceVariableInPrompt(promptText, addition.variable, oldValue, addition.value)
      : appendVariableToPrompt(promptText, addition.variable, addition.value);

    return {
      newPromptText,
      newVariables,
      variableChanged: addition.variable,
      oldValue,
      newValue: addition.value,
      strategy: 'add_trust_signal',
      reason: addition.description,
    };
  }

  // ── Strategy C: Swap a recipe variable to a different value ──
  if (action === 'change_recipe' && pool.alternatives) {
    const swappableVars = existingTargets.filter(t => pool.alternatives[t]);

    if (swappableVars.length > 0) {
      const targetVar = pickRandom(swappableVars);
      const oldValue = variables[targetVar];
      const newValue = pickDifferent(pool.alternatives[targetVar], oldValue);

      const newVariables = { ...variables, [targetVar]: newValue };
      const newPromptText = replaceVariableInPrompt(promptText, targetVar, oldValue, newValue);

      return {
        newPromptText,
        newVariables,
        variableChanged: targetVar,
        oldValue,
        newValue,
        strategy: 'swap_recipe_variable',
        reason: `Changed "${targetVar}" from "${oldValue}" to "${newValue}" to combat ad fatigue`,
      };
    }

    // No known alternatives — pick a random target and set a default
    if (existingTargets.length > 0) {
      const targetVar = pickRandom(existingTargets);
      const oldValue = variables[targetVar];
      // For unknown variables, append "(variation)" to signal it needs manual review
      const newValue = `${oldValue} (variation)`;

      return {
        newPromptText: promptText,
        newVariables: { ...variables, [targetVar]: newValue },
        variableChanged: targetVar,
        oldValue,
        newValue,
        strategy: 'flag_for_manual_change',
        reason: `Flagged "${targetVar}" for manual variation — no automatic alternatives available`,
      };
    }
  }

  // ── Strategy D: Improve relevance by transforming benefit text ──
  if (action === 'improve_relevance' && pool.strategies && existingTargets.length > 0) {
    const targetVar = pickRandom(existingTargets);
    const oldValue = variables[targetVar];
    const strategy = pickRandom(pool.strategies);
    const newValue = strategy.transform(oldValue);

    const newVariables = { ...variables, [targetVar]: newValue };
    const newPromptText = replaceVariableInPrompt(promptText, targetVar, oldValue, newValue);

    return {
      newPromptText,
      newVariables,
      variableChanged: targetVar,
      oldValue,
      newValue,
      strategy: strategy.name,
      reason: `${strategy.description}: "${targetVar}" changed from "${oldValue}" to "${newValue}"`,
    };
  }

  // ── Fallback: No matching variables found ──
  return {
    newPromptText: promptText,
    newVariables: variables,
    variableChanged: null,
    oldValue: null,
    newValue: null,
    strategy: 'no_match',
    reason: `No matching variables found in prompt for action "${action}". Prompt may need manual variable tagging. Expected one of: ${pool.targets.join(', ')}`,
  };
}

/**
 * Replace a variable's value in the prompt text.
 * Handles both {{variable}} template syntax and raw value occurrences.
 */
function replaceVariableInPrompt(promptText, variableName, oldValue, newValue) {
  let result = promptText;

  // Replace {{variable: oldValue}} patterns
  const templatePattern = new RegExp(
    `\\{\\{\\s*${escapeRegex(variableName)}\\s*:\\s*${escapeRegex(oldValue)}\\s*\\}\\}`,
    'gi'
  );
  result = result.replace(templatePattern, `{{${variableName}: ${newValue}}}`);

  // Replace raw old value occurrences (case-insensitive, whole word)
  if (oldValue && result === promptText) {
    // Only do raw replacement if template replacement didn't match
    const rawPattern = new RegExp(`\\b${escapeRegex(oldValue)}\\b`, 'gi');
    result = result.replace(rawPattern, newValue);
  }

  return result;
}

/**
 * Append a new variable to the prompt text.
 */
function appendVariableToPrompt(promptText, variableName, value) {
  return `${promptText}\n{{${variableName}: ${value}}}`;
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  mutate,
  MUTATION_POOLS,
  replaceVariableInPrompt,
  appendVariableToPrompt,
};

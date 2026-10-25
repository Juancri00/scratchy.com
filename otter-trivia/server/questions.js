'use strict';

// The trivia bank. Each question lists its choices with exactly one correct
// answer; order here does not matter because every participant gets their own
// shuffled question and choice order. Explanations mentioning Otter should be
// checked by Otter marketing before the event.
const QUESTIONS = [
  {
    id: 'q1',
    prompt: 'Which U.S. day is especially popular for restaurant dining out?',
    choices: [
      { id: 'a', text: 'Mother’s Day', correct: true },
      { id: 'b', text: 'April Fool’s Day' },
      { id: 'c', text: 'Groundhog Day' },
    ],
    explanation: 'Mother’s Day is consistently one of the busiest dining-out days of the year. Plan specials and staffing early!',
  },
  {
    id: 'q2',
    prompt: 'What does “86” mean in restaurant slang?',
    choices: [
      { id: 'a', text: 'A table is ready' },
      { id: 'b', text: 'An item is unavailable', correct: true },
      { id: 'c', text: 'A 6% discount' },
    ],
    explanation: '“86 the salmon” means it’s out. Keeping item availability in sync across your ordering channels avoids disappointed guests.',
  },
  {
    id: 'q3',
    prompt: 'What is food cost percentage?',
    choices: [
      { id: 'a', text: 'Food cost divided by food sales', correct: true },
      { id: 'b', text: 'Rent divided by total sales' },
      { id: 'c', text: 'Tips divided by labor cost' },
    ],
    explanation: 'Food cost ÷ food sales × 100. It’s one of the clearest signals of menu profitability.',
  },
  {
    id: 'q4',
    prompt: 'What is a restaurant’s average check?',
    choices: [
      { id: 'a', text: 'Average amount spent per transaction or guest', correct: true },
      { id: 'b', text: 'Total rent paid' },
      { id: 'c', text: 'Number of tables' },
    ],
    explanation: 'Total sales ÷ number of checks (or guests). Smart upsells and add-ons help it grow.',
  },
  {
    id: 'q5',
    prompt: 'Which statement best describes Otter’s POS integrations?',
    choices: [
      { id: 'a', text: 'Otter only works with its own POS' },
      { id: 'b', text: 'Otter integrates with different POS systems', correct: true },
      { id: 'c', text: 'Otter only works with cash registers' },
    ],
    explanation: 'Otter connects with a range of POS systems, so orders can flow into the setup you already use.',
  },
  {
    id: 'q6',
    prompt: 'Which tools can Otter help restaurants manage through its platform?',
    choices: [
      { id: 'a', text: 'Online ordering and kitchen operations', correct: true },
      { id: 'b', text: 'Hotel room bookings only' },
      { id: 'c', text: 'Airline reservations' },
    ],
    explanation: 'Otter brings online orders and kitchen operations together in one place, so your team spends less time juggling tablets.',
  },
  {
    id: 'q7',
    prompt: 'Which U.S. event is one of the biggest occasions for pizza orders?',
    choices: [
      { id: 'a', text: 'Super Bowl Sunday', correct: true },
      { id: 'b', text: 'April Fool’s Day' },
      { id: 'c', text: 'Groundhog Day' },
    ],
    explanation: 'Super Bowl Sunday is one of the biggest pizza days of the year. Delivery and takeout volume spikes fast!',
  },
  {
    id: 'q8',
    prompt: 'Which kitchen tool checks a food’s internal temperature?',
    choices: [
      { id: 'a', text: 'Thermometer', correct: true },
      { id: 'b', text: 'Measuring cup' },
      { id: 'c', text: 'Timer only' },
    ],
    explanation: 'A food thermometer is the reliable way to confirm food has reached a safe internal temperature.',
  },
];

for (const q of QUESTIONS) {
  if (q.choices.filter((c) => c.correct).length !== 1) {
    throw new Error(`Question ${q.id} must have exactly one correct choice`);
  }
}

const BY_ID = new Map(QUESTIONS.map((q) => [q.id, q]));

module.exports = { QUESTIONS, BY_ID };

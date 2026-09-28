import type { Answers, Diagnosis } from '../lib/diagnosis';
import { questionnaire } from '../lib/diagnosis';
import type { ProductCategory } from '../db/types';

export function Questionnaire({
  category,
  answers,
  onChange,
}: {
  category: ProductCategory;
  answers: Answers;
  onChange: (a: Answers) => void;
}) {
  const questions = questionnaire(category);
  const set = (id: string, v: string) => onChange({ ...answers, [id]: answers[id] === v ? '' : v });
  return (
    <div className="stack">
      {questions.map((q, i) => (
        <div key={q.id}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>
            {i + 1}. {q.text}
          </div>
          {q.options ? (
            <div className="row">
              {q.options.map((o) => (
                <button
                  type="button"
                  key={o}
                  className={`sm ${answers[q.id] === o ? 'primary' : ''}`}
                  aria-pressed={answers[q.id] === o}
                  onClick={() => set(q.id, o)}
                >
                  {o}
                </button>
              ))}
            </div>
          ) : (
            <input
              value={answers[q.id] ?? ''}
              onChange={(e) => onChange({ ...answers, [q.id]: e.target.value })}
              placeholder="Leave blank if none"
            />
          )}
        </div>
      ))}
    </div>
  );
}

export function SuggestionPanel({ diagnosis, compact = false }: { diagnosis: Diagnosis; compact?: boolean }) {
  const { suggestions, advice, priority } = diagnosis;
  return (
    <div className="stack">
      {priority && (
        <div className={`alert-box ${priority === 'Critical' ? 'critical' : ''}`}>
          <strong>Suggested priority: {priority}</strong>
        </div>
      )}
      {advice.map((a) => (
        <div key={a} className="alert-box info">
          {a}
        </div>
      ))}
      {suggestions.length === 0 ? (
        <p className="muted small">
          Answer the questions and type what the customer says. Likely causes will show here.
        </p>
      ) : (
        suggestions.map((s, i) => (
          <div key={s.cause.id} className="card" style={{ padding: 12, boxShadow: 'none' }}>
            <div className="row between">
              <strong>
                {i + 1}. {s.cause.name}
              </strong>
              <span className={`badge ${i === 0 ? 'primary' : ''}`}>{s.likelihood}%</span>
            </div>
            <div className="bar" style={{ margin: '6px 0' }}>
              <span style={{ width: `${s.likelihood}%` }} />
            </div>
            {!compact && <p className="small">{s.cause.check}</p>}
            {!compact && s.cause.carry && (
              <p className="small">
                <span className="muted">Carry:</span> {s.cause.carry.join(', ')}
              </p>
            )}
            <p className="small muted" style={{ margin: 0 }}>
              Why: {s.reasons.join('; ')}
            </p>
          </div>
        ))
      )}
    </div>
  );
}

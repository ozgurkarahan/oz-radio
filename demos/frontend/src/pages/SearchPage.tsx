import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Mic, Search, SearchX } from 'lucide-react';
import { SearchResult, searchDecks } from '../services/decksApi';
import { useAuth } from '../services/auth';
import { GatedPanel } from '../components/AuthGate';
import {
  Alert, Button, EmptyState, Field, Input, PageHeader, Spinner, episodeNumber, humanizeTitle,
} from '../ui';
import '../styles/pages/search.css';

const EXAMPLES = [
  'How do we prevent phishing?',
  'What is GDPR?',
  'Explain our incident response process',
];

export default function SearchPage() {
  const auth = useAuth();
  if (auth.loading) {
    return <div className="container page search-state"><Spinner label="Loading…" /></div>;
  }
  if (!auth.is_admin) {
    return (
      <div className="container page">
        <h1 className="sr-only">Search</h1>
        <GatedPanel
          icon={Search}
          title="Search across decks is for the site owner"
          description="Search runs a semantic search over every deck and lets the live avatar present the matching slide. You can start the live demo of a published deck without signing in, or browse the decks and videos."
          action="ask questions across the decks"
          links={[{ href: '/decks', label: 'Browse the decks' }, { href: '/video/library', label: 'Browse the video library' }]}
        />
      </div>
    );
  }
  return <DeckSearch />;
}

function DeckSearch() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(q: string) {
    const qv = q.trim();
    if (!qv) return;
    setQuery(qv);
    setLoading(true);
    setError(null);
    try {
      const r = await searchDecks(qv, 5);
      setResults(r.results || []);
    } catch (e: any) {
      setError(String(e?.message ?? e));
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  function present(r: SearchResult) {
    navigate(`/decks/${r.deck_id}/present?slide=${r.slide_index}&autoplay=1`);
  }

  return (
    <div className="container page search-page">
      <PageHeader
        eyebrow="Search"
        title="Ask anything about your decks"
        lead="We'll find the matching slide and the avatar will present it to you."
      />

      <form
        className="search-form"
        role="search"
        onSubmit={(e) => { e.preventDefault(); submit(query); }}
      >
        <Field label="Your question" labelHidden className="search-form__field">
          <Input
            data-testid="search-input"
            type="text"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Ask anything about your decks…"
            className="search-form__input"
          />
        </Field>
        <Button
          type="submit"
          variant="primary"
          size="lg"
          icon={Search}
          busy={loading}
          disabled={!query.trim()}
          className="search-form__submit"
        >
          {loading ? 'Searching…' : 'Search'}
        </Button>
      </form>

      {error && <Alert tone="error" className="search-alert">{error}</Alert>}

      {loading && (
        <div className="search-state"><Spinner label="Searching your decks…" /></div>
      )}

      {!loading && results === null && (
        <div className="search-examples">
          <span className="eyebrow">Try</span>
          <ul className="search-examples__list">
            {EXAMPLES.map((e) => (
              <li key={e}>
                <button type="button" className="search-example" onClick={() => submit(e)}>{e}</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!loading && results !== null && results.length === 0 && (
        <EmptyState icon={SearchX} title="No results">
          Try rephrasing, or upload more decks in <Link to="/decks">Decks</Link>.
        </EmptyState>
      )}

      {!loading && results && results.length > 0 && (
        <ol className="search-results" aria-label="Search results">
          {results.map((r, idx) => {
            const slideLabel = `Slide ${r.slide_index + 1}`;
            return (
              <li
                key={`${r.deck_id}-${r.slide_index}-${idx}`}
                data-testid="search-result"
                className="search-result"
              >
                <span className="search-result__num" aria-hidden>{episodeNumber(idx + 1)}</span>
                <div className="search-result__body">
                  <div className="search-result__source">
                    <span className="search-result__deck" title={r.deck_title}>{humanizeTitle(r.deck_title)}</span>
                    <span aria-hidden>·</span>
                    <span>{slideLabel}</span>
                  </div>
                  <h2 className="search-result__title">{r.slide_title || slideLabel}</h2>
                  {r.snippet && <blockquote className="search-result__snippet">{r.snippet}</blockquote>}
                  <div className="search-result__foot">
                    <span className="search-result__score tabular">
                      Relevance {r.score?.toFixed?.(2) ?? r.score}
                    </span>
                    <Button size="sm" variant="primary" icon={Mic} onClick={() => present(r)}>
                      Present this slide
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

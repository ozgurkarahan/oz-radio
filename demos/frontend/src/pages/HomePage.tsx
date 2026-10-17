import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowRight, Clapperboard, Headphones, Layers, ListMusic, Mic, Play, Search, type LucideIcon,
} from 'lucide-react';
import { useAuth } from '../services/auth';
import { useDemoConfig } from '../services/demo';
import { type Deck, listDecks } from '../services/decksApi';
import { listLibrary as listVideos, type LibrarySummary as VideoSummary } from '../services/videoApi';
import { listLibrary as listPodcasts, isAudioOnly, type LibrarySummary as PodcastSummary } from '../services/podcast';
import { type AvatarInfo, pickDefaultAvatar, useAvatars } from '../services/avatars';
import {
  Button, ButtonLink, EpisodeList, EpisodeRow, HostDisc, HostsMini, LivePill, SectionHead,
  episodeNumber, formatDuration, humanizeTitle, languageName, pluralize,
} from '../ui';
import '../styles/pages/home.css';

type Dept = { to: string; icon: LucideIcon; kicker: string; title: string; desc: string; adminOnly?: boolean };

const DEPARTMENTS: Dept[] = [
  { to: '/decks', icon: Layers, kicker: 'Decks', title: 'Browse & present', desc: 'Every published deck, presented slide by slide by the live avatar.' },
  { to: '/search', icon: Search, kicker: 'Search', title: 'Ask your decks', desc: 'Ask anything; the right slide is found and presented for you.', adminOnly: true },
  { to: '/playlists', icon: ListMusic, kicker: 'Playlists', title: 'Learning paths', desc: 'Chain decks into ordered playlists and resume where you left off.', adminOnly: true },
  { to: '/live', icon: Mic, kicker: 'Live', title: 'Present a new deck', desc: 'Drop a .pptx and the avatar presents it, with Q&A grounded in the slides.', adminOnly: true },
  { to: '/video/library', icon: Clapperboard, kicker: 'Video', title: 'Narrated videos', desc: 'Avatar-narrated videos with subtitles and a SCORM package.' },
  { to: '/podcast/library', icon: Headphones, kicker: 'Podcast', title: 'Two-host podcasts', desc: 'Two avatars discuss your document in a podcast conversation.' },
];

type Episode = {
  key: string;
  kind: 'deck' | 'video' | 'podcast';
  title: string;
  date: number;
  to: string;
  meta: string[];
  hosts: (AvatarInfo | undefined)[];
  duration: string;
  live?: boolean;
};

const KIND: Record<Episode['kind'], { icon: LucideIcon; label: string }> = {
  deck: { icon: Mic, label: 'Live presentation' },
  video: { icon: Clapperboard, label: 'Narrated video' },
  podcast: { icon: Headphones, label: 'Podcast' },
};

const time = (iso?: string | null) => (iso ? new Date(iso).getTime() || 0 : 0);

/** Deep link that opens the episode in the podcast library player (Listen for audio-only episodes). */
const podcastLink = (p: PodcastSummary) =>
  `/podcast/library?${new URLSearchParams({ episode: p.job_id, mode: isAudioOnly(p) ? 'listen' : 'watch' })}`;

export default function HomePage() {
  const navigate = useNavigate();
  const auth = useAuth();
  const locked = !auth.loading && !auth.is_admin;
  const demo = useDemoConfig();
  const { avatars } = useAvatars();
  const [decks, setDecks] = useState<Deck[]>([]);
  const [videos, setVideos] = useState<VideoSummary[]>([]);
  const [podcasts, setPodcasts] = useState<PodcastSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    listDecks().then((d) => { if (!cancelled) setDecks(d); }).catch(() => { /* home stays usable */ });
    listVideos().then((v) => { if (!cancelled) setVideos(v); }).catch(() => {});
    listPodcasts().then((p) => { if (!cancelled) setPodcasts(p); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Surface the anonymous live avatar demo when at least one deck allows it.
  const demoDeck = locked && demo.enabled ? decks.find((d) => d.live_demo) ?? null : null;

  const lead = pickDefaultAvatar(avatars);
  const co = useMemo(() => {
    const others = avatars.filter((a) => a.id !== lead?.id);
    return others.find((a) => a.gender !== lead?.gender && a.thumbnail_url)
      ?? others.find((a) => a.gender !== lead?.gender)
      ?? others[0];
  }, [avatars, lead]);
  const byName = (name?: string | null) => avatars.find((a) => a.display_name === name);

  const episodes = useMemo<Episode[]>(() => {
    const items: Episode[] = [
      ...decks.map((d) => ({
        key: `deck-${d.deck_id}`, kind: 'deck' as const, title: humanizeTitle(d.title), date: time(d.uploaded_at),
        to: `/decks/${d.deck_id}/present`, meta: [pluralize(d.slide_count, 'slide'), languageName(d.language)],
        hosts: [lead], duration: '', live: !!d.live_demo && demo.enabled,
      })),
      ...videos.map((v) => ({
        key: `video-${v.job_id}`, kind: 'video' as const, title: humanizeTitle(v.title || v.document_title), date: time(v.created_at),
        to: '/video/library', meta: ['Narrated video', languageName(v.language)], hosts: [lead],
        duration: formatDuration(v.duration_sec),
      })),
      ...podcasts.map((p) => {
        const named = (p.speaker_names ?? []).map(byName).filter(Boolean) as AvatarInfo[];
        return {
          key: `podcast-${p.job_id}`, kind: 'podcast' as const, title: humanizeTitle(p.title || p.document_title), date: time(p.created_at),
          to: podcastLink(p), meta: ['Podcast', languageName(p.language)],
          hosts: named.length ? named : [lead, co], duration: formatDuration(p.duration_sec),
        };
      }),
    ];
    return items.sort((a, b) => b.date - a.date).slice(0, 6);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decks, videos, podcasts, avatars, demo.enabled]);

  const minutes = Math.max(1, Math.round(demo.session_seconds / 60));

  return (
    <div className="container page" style={{ paddingTop: 0 }}>
      <section className="home-hero" aria-labelledby="home-title">
        <div className="home-hero__copy">
          <div className="eyebrow">Presented · Narrated · Podcast — by AI hosts</div>
          <h1 id="home-title" className="display home-hero__title">
            Every deck deserves a <em>great host.</em>
          </h1>
          <p className="lead">
            AI avatars that present, narrate and podcast your decks. Upload once, ask anything —
            {lead?.display_name ? ` ${lead.display_name}` : ' the avatar'} presents the exact slide that answers you.
          </p>
          <div className="home-hero__ctas">
            {demoDeck ? (
              <Button
                variant="primary"
                size="lg"
                icon={Play}
                data-testid="home-try-live-demo"
                onClick={() => navigate(`/decks/${demoDeck.deck_id}/present`)}
              >
                Watch the live demo
              </Button>
            ) : (
              <ButtonLink to="/decks" variant="primary" size="lg" icon={Layers}>Browse decks</ButtonLink>
            )}
            <ButtonLink to={demoDeck ? '/decks' : '/podcast/library'} size="lg">
              {demoDeck ? 'Browse decks' : 'Listen to a podcast'}
            </ButtonLink>
            {demoDeck && (
              <span className="home-hero__note" data-testid="home-demo-note">
                {demo.qa.enabled ? 'Ask questions by voice' : 'Narration-only'} · up to {minutes} min · no sign-in
              </span>
            )}
          </div>
        </div>

        <div className="home-hosts" aria-label="Your hosts">
          {lead && (
            <div className="home-host home-host--lead">
              <HostDisc host={lead} ring speaking style={{ '--disc': 'clamp(170px, 22vw, 260px)' } as React.CSSProperties} />
              <div className="home-host__role">
                {demoDeck ? <LivePill>On air</LivePill> : <span className="eyebrow">Host</span>}
                <span className="home-host__name">{lead.display_name}</span>
              </div>
            </div>
          )}
          {co && (
            <div className="home-host home-host--co">
              <HostDisc host={co} tone="sand" style={{ '--disc': 'clamp(110px, 14vw, 180px)' } as React.CSSProperties} />
              <div className="home-host__role">
                <span className="eyebrow">Co-host</span>
                <span className="home-host__name">{co.display_name}</span>
              </div>
            </div>
          )}
        </div>
      </section>

      {episodes.length > 0 && (
        <section className="home-section" aria-labelledby="home-episodes">
          <SectionHead
            className="home-section__head"
            title={<span id="home-episodes">This week on Oz Radio</span>}
            aside={pluralize(decks.length + videos.length + podcasts.length, 'episode')}
          />
          <EpisodeList label="Latest episodes">
            {episodes.map((e, i) => (
              <EpisodeRow
                key={e.key}
                num={episodeNumber(i + 1)}
                title={e.title}
                to={e.to}
                meta={e.meta}
                kind={KIND[e.kind]}
                hosts={<HostsMini hosts={e.hosts} />}
                duration={e.live ? <LivePill>Live demo</LivePill> : e.duration}
                actions={(
                  <Link
                    to={e.to}
                    className={`btn btn--icon btn--sm${i === 0 ? ' btn--primary' : ''}`}
                    aria-label={`Open ${e.title}`}
                  >
                    <Play aria-hidden />
                  </Link>
                )}
              />
            ))}
          </EpisodeList>
        </section>
      )}

      <section className="home-section" aria-labelledby="home-sections">
        <SectionHead className="home-section__head" title={<span id="home-sections">Inside Oz Radio</span>} aside="Six ways in" />
        <div className="home-departments">
          {DEPARTMENTS.map((d) => (
            <Link key={d.to} to={d.to} className="home-dept">
              <span className="home-dept__kicker eyebrow"><d.icon aria-hidden />{d.kicker}</span>
              <span className="home-dept__title">{d.title}</span>
              <span className="home-dept__desc">{d.desc}</span>
              <span className="home-dept__cta">
                {locked && d.adminOnly
                  ? <span className="home-dept__lock">Sign-in required</span>
                  : <>Open {d.kicker} <ArrowRight aria-hidden /></>}
              </span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}

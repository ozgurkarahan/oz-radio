import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight, Clapperboard, Headphones, Layers, ListMusic, Mic, Play, Search, type LucideIcon,
} from 'lucide-react';
import { useAuth } from '../services/auth';
import { type Deck, listDecks } from '../services/decksApi';
import { listLibrary as listVideos, type LibrarySummary as VideoSummary } from '../services/videoApi';
import { listLibrary as listPodcasts, hasAudio, isAudioOnly, type LibrarySummary as PodcastSummary } from '../services/podcast';
import { type AvatarInfo, pickDefaultAvatar, useAvatars } from '../services/avatars';
import { usePrefersListen } from '../playback/prefersListen';
import { markHomeCta } from '../services/telemetry';
import {
  DemoActionLink, LiveDemoBadge, OWNER_SIGN_IN_HINT, liveSessionsLeft, recordedDemoReason, useDemoEntry, type DemoEntry,
} from '../components/AuthGate';
import {
  Alert, Button, ButtonLink, EmptyState, EpisodeList, EpisodeRow, HostDisc, HostsMini, SectionHead, Spinner,
  episodeNumber, formatDuration, humanizeTitle, languageName, loadErrorMessage, pluralize, recordingTitle,
  type AudienceLevelValue,
} from '../ui';
import '../styles/pages/home.css';

type Dept = { to: string; icon: LucideIcon; kicker: string; title: string; desc: string };

/** What every visitor can open. */
const PUBLIC_DEPARTMENTS: Dept[] = [
  { to: '/decks', icon: Layers, kicker: 'Decks', title: 'Browse and present', desc: 'Every published deck, slide by slide, including the one the live avatar narrates.' },
  { to: '/video/library', icon: Clapperboard, kicker: 'Video', title: 'Narrated videos', desc: 'Decks narrated by an AI host. Language and level are shown on each video.' },
  { to: '/podcast/library', icon: Headphones, kicker: 'Podcast', title: 'Two-host podcasts', desc: 'Two AI hosts discuss a document as a conversation. Listen on the go or watch.' },
];

/** Owner tools: grouped apart and marked "Sign-in required" for visitors. */
const OWNER_DEPARTMENTS: Dept[] = [
  { to: '/search', icon: Search, kicker: 'Search', title: 'Ask your decks', desc: 'Ask anything; the right slide is found and presented for you.' },
  { to: '/playlists', icon: ListMusic, kicker: 'Playlists', title: 'Learning paths', desc: 'Chain decks into ordered playlists and resume where you left off.' },
  { to: '/live', icon: Mic, kicker: 'Live', title: 'Present a deck live', desc: 'Drop a .pptx and the avatar presents it, with Q&A grounded in the slides.' },
];

type Kind = { icon: LucideIcon; label: string };

type Episode = {
  key: string;
  kind: Kind;
  title: string;
  date: number;
  to: string;
  meta: string[];
  hosts: (AvatarInfo | undefined)[];
  duration: string;
  level?: AudienceLevelValue | null;
  language?: string;
  live?: boolean;
};

// "Live presentation" is only a deck that visitors can actually start live; the other decks are slides.
const DECK_LIVE: Kind = { icon: Mic, label: 'Live presentation' };
const DECK_SLIDES: Kind = { icon: Layers, label: 'Slides' };
const VIDEO: Kind = { icon: Clapperboard, label: 'Narrated video' };
const PODCAST: Kind = { icon: Headphones, label: 'Podcast' };

const time = (iso?: string | null) => (iso ? new Date(iso).getTime() || 0 : 0);

/**
 * Deep link that opens the episode in the podcast library player: Listen for audio-only episodes,
 * and on touch phones (`listenFirst`) for every episode with audio, like the library rows.
 */
const podcastLink = (p: PodcastSummary, listenFirst: boolean) => {
  const mode = isAudioOnly(p) || (listenFirst && hasAudio(p)) ? 'listen' : 'watch';
  return `/podcast/library?${new URLSearchParams({ episode: p.job_id, mode })}`;
};

interface HomeData {
  phase: 'loading' | 'ready';
  decks: Deck[];
  videos: VideoSummary[];
  podcasts: PodcastSummary[];
  /** A list that failed is not an empty list: it gets an error and "Try again", never "nothing is published". */
  failed: { decks: boolean; videos: boolean; podcasts: boolean };
  /** The first rejection, only ever read through `loadErrorMessage` (never printed). */
  reason: unknown;
}

const LOADING: HomeData = {
  phase: 'loading', decks: [], videos: [], podcasts: [], failed: { decks: false, videos: false, podcasts: false }, reason: null,
};

/** The three public lists, loaded together so the episode rows appear (and are ordered) once. */
function useHomeData() {
  const [data, setData] = useState<HomeData>(LOADING);
  const [retrying, setRetrying] = useState(false);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    const [decks, videos, podcasts] = await Promise.allSettled([listDecks(), listVideos(), listPodcasts()]);
    if (!mounted.current) return;
    const rejected = [decks, videos, podcasts].find((r): r is PromiseRejectedResult => r.status === 'rejected');
    setData({
      phase: 'ready',
      decks: decks.status === 'fulfilled' ? decks.value : [],
      videos: videos.status === 'fulfilled' ? videos.value : [],
      podcasts: podcasts.status === 'fulfilled' ? podcasts.value : [],
      failed: { decks: decks.status === 'rejected', videos: videos.status === 'rejected', podcasts: podcasts.status === 'rejected' },
      reason: rejected ? rejected.reason : null,
    });
  }, []);

  useEffect(() => {
    mounted.current = true;
    load();
    return () => { mounted.current = false; };
  }, [load]);

  const retry = useCallback(async () => {
    setRetrying(true);
    await load();
    if (mounted.current) setRetrying(false);
  }, [load]);

  return { data, retry, retrying };
}

/** Status text beside the demo link: what the session is like, or why only the recording is offered. */
function DemoStatus({ entry }: { entry: DemoEntry }) {
  let note: string | null = null;
  let quota: string | null = null;
  if (entry.kind === 'live') {
    const minutes = Math.max(1, Math.round(entry.sessionSeconds / 60));
    // Each segment keeps its trailing dot (nowrap): a wrapped line never starts with "·".
    note = [`${entry.qa ? 'Ask questions by voice' : 'Narration-only'}`, `up to ${minutes} min`, 'no sign-in'].join(' · ');
    quota = entry.remaining === null ? null : liveSessionsLeft(entry.remaining);
  } else if (entry.kind === 'recorded') {
    note = recordedDemoReason(entry.reason);
  }
  return (
    <p className="home-hero__status">
      {note && (
        <span data-testid="home-demo-note">
          {note.split(' · ').map((part, i, all) => (
            <React.Fragment key={part}>
              {i > 0 && ' '}
              <span className="home-hero__seg">{i < all.length - 1 ? `${part} ·` : part}</span>
            </React.Fragment>
          ))}
        </span>
      )}
      {quota && <span data-testid="home-demo-quota">{quota}</span>}
    </p>
  );
}

export default function HomePage() {
  const auth = useAuth();
  // Default deny: a visitor never sees owner tools as open links, not even before /api/me answers.
  const locked = !auth.is_admin;
  const entry = useDemoEntry();
  useEffect(() => markHomeCta(entry.kind), [entry.kind]); // telemetry: the call to action is shown in its final form
  const { avatars } = useAvatars();
  const listenFirst = usePrefersListen();
  const { data, retry, retrying } = useHomeData();

  const lead = pickDefaultAvatar(avatars);
  const co = useMemo(() => {
    const others = avatars.filter((a) => a.id !== lead?.id);
    return others.find((a) => a.gender !== lead?.gender && a.thumbnail_url)
      ?? others.find((a) => a.gender !== lead?.gender)
      ?? others[0];
  }, [avatars, lead]);
  const byName = (name?: string | null) => avatars.find((a) => a.display_name === name);

  // Rows wait for the demo entry too, so a deck's kind label never flips from "Slides" to "Live presentation".
  const ready = data.phase === 'ready' && entry.kind !== 'pending';
  const liveNow = entry.kind === 'live';

  const episodes = useMemo<Episode[]>(() => {
    const items: Episode[] = [
      ...data.decks.map((d) => {
        const live = !!d.live_demo && liveNow;
        return {
          key: `deck-${d.deck_id}`, kind: live ? DECK_LIVE : DECK_SLIDES, title: humanizeTitle(d.title), date: time(d.uploaded_at),
          to: `/decks/${d.deck_id}/present`, meta: [pluralize(d.slide_count, 'slide'), languageName(d.language)],
          hosts: [lead], duration: '', level: d.audience_level, language: d.language, live,
        };
      }),
      ...data.videos.map((v) => ({
        key: `video-${v.job_id}`, kind: VIDEO,         title: recordingTitle(v.title || v.document_title), date: time(v.created_at),
                to: `/video/library?video=${encodeURIComponent(v.job_id)}`, meta: ['Narrated video', languageName(v.language)], hosts: [lead],
        duration: formatDuration(v.duration_sec), level: v.audience_level, language: v.language,
      })),
      ...data.podcasts.map((p) => {
        const named = (p.speaker_names ?? []).map(byName).filter(Boolean) as AvatarInfo[];
        return {
          key: `podcast-${p.job_id}`, kind: PODCAST, title: recordingTitle(p.title || p.document_title), date: time(p.created_at),
          to: podcastLink(p, listenFirst), meta: ['Podcast', languageName(p.language)],
          hosts: named.length ? named : [lead, co], duration: formatDuration(p.duration_sec),
          level: p.audience_level, language: p.language,
        };
      }),
    ];
    return items.sort((a, b) => b.date - a.date).slice(0, 6);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, avatars, liveNow, listenFirst]);

  const failedCount = Object.values(data.failed).filter(Boolean).length;
  const allFailed = failedCount === 3;
  const episodeCount = data.videos.length + data.podcasts.length; // decks are slides, not episodes
  const total = data.decks.length + episodeCount;

  return (
    <div className="container page" style={{ paddingTop: 0 }}>
      <section className="home-hero" aria-labelledby="home-title">
        <div className="home-hero__copy">
          <h1 id="home-title" className="display home-hero__title">
            Every deck deserves a <em>great host.</em>
          </h1>
          <p className="lead">
            AI hosts explain slide decks and discuss them as podcasts. Listen, watch, or try the live demo — free, no sign-in.
          </p>
          <div className="home-hero__ctas" aria-busy={entry.kind === 'pending' || undefined}>
            <DemoActionLink
              entry={entry}
              size="lg"
              className="home-hero__cta"
              testIdLive="home-try-live-demo"
              testIdRecorded="home-watch-recorded-demo"
            />
            <ButtonLink to="/podcast/library" size="lg" icon={Headphones}>Listen to an episode</ButtonLink>
            <ButtonLink to="/decks" size="lg" variant="link" iconRight={ArrowRight} className="home-hero__browse">Browse decks</ButtonLink>
          </div>
          <DemoStatus entry={entry} />
        </div>

        <div className="home-hosts" role="group" aria-label="Your hosts">
          {lead && (
            <div className="home-host home-host--lead">
              <HostDisc host={lead} ring speaking style={{ '--disc': 'clamp(170px, 22vw, 260px)' } as React.CSSProperties} />
              <div className="home-host__role">
                <span className="eyebrow">Host</span>
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

      <section className="home-section" aria-labelledby="home-episodes">
        <SectionHead
          className="home-section__head"
          title={<span id="home-episodes">Latest on Oz Radio</span>}
          aside={ready && episodeCount > 0 ? pluralize(episodeCount, 'episode') : undefined}
        />
        {!ready ? (
          <div className="home-episodes__loading" aria-busy="true"><Spinner label="Loading episodes…" /></div>
        ) : (
          <>
            {failedCount > 0 && (
              <Alert tone={allFailed ? 'error' : 'info'} className="home-episodes__alert" data-testid="home-load-error">
                <div className="cluster">
                  <span>{loadErrorMessage(data.reason, allFailed ? 'the latest episodes' : 'some episodes')}</span>
                  <Button size="sm" onClick={retry} busy={retrying}>Try again</Button>
                </div>
              </Alert>
            )}
            {episodes.length > 0 && (
              <EpisodeList label="Latest episodes">
                {episodes.map((e, i) => (
                  <EpisodeRow
                    key={e.key}
                    data-testid="home-episode"
                    num={episodeNumber(i + 1)}
                    title={e.title}
                    to={e.to}
                    meta={e.meta}
                    kind={e.kind}
                    level={e.level}
                    lang={e.language}
                    hosts={<HostsMini hosts={e.hosts} />}
                    duration={e.duration}
                    extra={e.live ? <LiveDemoBadge liveDemo /> : undefined}
                    actions={(
                      <Link
                        to={e.to}
                        className={`btn btn--icon btn--sm${i === 0 ? ' btn--primary' : ''}`}
                        aria-hidden
                        tabIndex={-1}
                      >
                        <Play aria-hidden />
                      </Link>
                    )}
                  />
                ))}
              </EpisodeList>
            )}
            {failedCount === 0 && total === 0 && (
              <EmptyState icon={Headphones} title="No episodes are published yet" className="home-empty">
                Decks, videos and podcasts appear here as soon as they are published. The live demo and the decks are ready now.
              </EmptyState>
            )}
          </>
        )}
      </section>

      <section className="home-section" aria-labelledby="home-sections">
        <SectionHead className="home-section__head" title={<span id="home-sections">Inside Oz Radio</span>} aside="Free to browse" />
        <div className="home-departments">
          {PUBLIC_DEPARTMENTS.map((d) => (
            <Link key={d.to} to={d.to} className="home-dept">
              <span className="home-dept__kicker eyebrow"><d.icon aria-hidden />{d.kicker}</span>
              <span className="home-dept__title">{d.title}</span>
              <span className="home-dept__desc">{d.desc}</span>
              <span className="home-dept__cta">Open {d.kicker} <ArrowRight aria-hidden /></span>
            </Link>
          ))}
        </div>
      </section>

      <section className={`home-section${locked ? ' home-section--locked' : ''}`} aria-labelledby="home-owner" data-testid="home-owner-tools">
        <SectionHead
          className="home-section__head"
          title={<span id="home-owner">Owner tools</span>}
          aside={locked ? 'Sign-in required' : undefined}
        />
        {locked && <p className="home-owner__hint">{OWNER_SIGN_IN_HINT}</p>}
        <div className="home-departments">
          {OWNER_DEPARTMENTS.map((d) => (
            <Link key={d.to} to={d.to} className="home-dept">
              <span className="home-dept__kicker eyebrow"><d.icon aria-hidden />{d.kicker}</span>
              <span className="home-dept__title">{d.title}</span>
              <span className="home-dept__desc">{d.desc}</span>
              <span className="home-dept__cta">
                {locked
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

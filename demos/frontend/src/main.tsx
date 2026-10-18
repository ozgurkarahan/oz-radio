import './styles/index.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom';
import LivePage from './pages/LivePage';
import PodcastPage from './pages/PodcastPage';
import PodcastLibraryPage from './pages/PodcastLibraryPage';
import VideoPage from './pages/VideoPage';
import VideoLibraryPage from './pages/VideoLibraryPage';
import HomePage from './pages/HomePage';
import SearchPage from './pages/SearchPage';
import DecksPage from './pages/DecksPage';
import DeckPresentPage from './pages/DeckPresentPage';
import PlaylistsPage from './pages/PlaylistsPage';
import PlaylistPlayerPage from './pages/PlaylistPlayerPage';
import TopNav from './components/TopNav';
import AuthToast from './components/AuthToast';
import ErrorBoundary from './components/ErrorBoundary';
import { AuthProvider, installAuthErrorInterceptor } from './services/auth';
import { installPlayerDebug, isPlayerDebugEnabled } from './debug/playerDebug';
import { PlaybackProvider } from './playback/PlaybackProvider';
import { MiniPlayer } from './playback/MiniPlayer';

installAuthErrorInterceptor();

// Opt-in on-device playback log (?debug=player): hooks before render, panel as a lazy chunk.
const playerDebug = isPlayerDebugEnabled();
if (playerDebug) installPlayerDebug();
const PlayerDebugPanel = playerDebug
  ? React.lazy<React.ComponentType>(() => import('./debug/PlayerDebugPanel').catch(() => ({ default: () => null })))
  : null;

function RoutedContent({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  return (
    <main id="main" tabIndex={-1} style={{ flex: 1, display: 'flex', flexDirection: 'column', outline: 'none' }}>
      <ErrorBoundary resetKey={pathname}>{children}</ErrorBoundary>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthProvider>
    <BrowserRouter>
      <PlaybackProvider>
      <TopNav />
      <AuthToast />
      <RoutedContent>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/live" element={<LivePage />} />
        <Route path="/decks" element={<DecksPage />} />
        <Route path="/decks/:deckId/present" element={<DeckPresentPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/playlists" element={<PlaylistsPage />} />
        <Route path="/playlists/:playlistId" element={<PlaylistPlayerPage />} />
        <Route path="/podcast" element={<PodcastPage />} />
        <Route path="/podcast/library" element={<PodcastLibraryPage />} />
        <Route path="/video" element={<VideoPage />} />
        <Route path="/video/library" element={<VideoLibraryPage />} />
      </Routes>
      </RoutedContent>
      <MiniPlayer />
      </PlaybackProvider>
    </BrowserRouter>
    </AuthProvider>
    {PlayerDebugPanel && <React.Suspense fallback={null}><PlayerDebugPanel /></React.Suspense>}
  </React.StrictMode>
);

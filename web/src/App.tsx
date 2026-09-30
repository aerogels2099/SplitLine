import { Suspense, lazy, useState, type FormEvent } from "react";
import { Navigate, NavLink, Route, Routes, useNavigate } from "react-router-dom";

const Home = lazy(() => import("./pages/Home"));
const Player = lazy(() => import("./pages/Player"));
const GameHistory = lazy(() => import("./pages/player/GameHistory"));
const Analysis = lazy(() => import("./pages/player/Analysis"));

function Logo() {
  return (
    <span className="mark" aria-hidden>
      <svg width="20" height="20" viewBox="0 0 16 16" shapeRendering="crispEdges">
        <g fill="#171205">
          <rect x="6" y="1" width="4" height="10" />
          <rect x="3" y="11" width="10" height="3" />
        </g>
      </svg>
    </span>
  );
}

export default function App() {
  const [query, setQuery] = useState("");
  const navigate = useNavigate();

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (q) {
      navigate(`/player/${encodeURIComponent(q)}`);
      setQuery("");
    }
  };

  return (
    <div className="shell">
      <header className="topbar">
        <NavLink to="/" className="brand" style={{ textDecoration: "none" }}>
          <Logo />
          <span className="word">
            Split<em>Line</em>
          </span>
        </NavLink>
        <form className="search" onSubmit={onSearch}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a player… (nickname or UUID)"
            aria-label="Find a player"
          />
          <button type="submit">Analyze</button>
        </form>
      </header>
      <Suspense fallback={<div className="card">Loading…</div>}>
      <Routes>
        {/* the dashboard is the home page; normalize the URL so the nav highlights */}
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<Home />} />
        <Route path="/player/:id" element={<Player />}>
          <Route index element={<GameHistory />} />
          <Route path="analysis" element={<Analysis />} />
        </Route>
      </Routes>
      </Suspense>
    </div>
  );
}

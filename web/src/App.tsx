import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import Home from "./pages/Home";

function Logo() {
  // Pixel beacon: a base block with a beam rising from it.
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
  return (
    <div className="shell">
      <header className="topbar">
        <NavLink to="/" className="brand" style={{ textDecoration: "none" }}>
          <Logo />
          <span className="word">
            Split<em>Line</em>
          </span>
        </NavLink>
        <nav className="topnav">
          <NavLink to="/dashboard">Dashboard</NavLink>
        </nav>
      </header>
      <Routes>
        {/* the dashboard is the home page; normalize the URL so the nav highlights */}
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<Home />} />
      </Routes>
    </div>
  );
}

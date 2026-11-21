import { BrowserRouter, Routes, Route } from 'react-router-dom'

import { NavBar } from './components'
import { ProtectedRoute } from './routes/ProtectedRoute'
import { BusinessRoute } from './routes/BusinessRoute'
import { AdminRoute } from './routes/AdminRoute'
import { AccountRedirect } from './routes/AccountRedirect'
import { GuestRoute } from './routes/GuestRoute'
import { NoBusinessRoute } from './routes/NoBusinessRoute'
import {
  BusinessLayout,
  AccountLayout,
} from './layouts'
import { Login } from './pages/public/Login'
import { Register } from './pages/public/Register'
import { AccountSettings } from './pages/account/AccountSettings'
import { CreateBusiness } from './pages/account/CreateBusiness'
import { Dashboard } from './pages/business/Dashboard'
import { Phone } from './pages/business/Phone'
import { CallHistory } from './pages/business/CallHistory'
import { Voicemail } from './pages/business/Voicemail'
import { Recordings } from './pages/business/Recordings'
import { Billing } from './pages/business/Billing'
import { Support } from './pages/business/Support'
import { Purchase } from './pages/business/Purchase'
import { CallRouting } from './pages/business/CallRouting'
import { TeamManagement } from "./pages/business/TeamsManagement";
import {
  AuthContextProvider,
  SoftphoneProvider,
} from './contexts'

function App() {
  return (
    <div className='App'>
      <AuthContextProvider>
        <SoftphoneProvider>
          <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <NavBar />

          <Routes>
          {/* Public routes. "/" IS the login page: the course's browser flow opens the site's root
              and fills data-testid login-email at once (spec §4 names the testids, not a URL).
              With a landing page there, every softphone flow timed out in locator.fill
              (docs/incidents/2026-11-20-support-tickets.md §1). Logged-in users are redirected
              by GuestRoute. */}
          <Route element={<GuestRoute />}>
            <Route path="/" element={<Login />} />
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
          </Route>

          {/* Protected routes */}
          <Route element={<ProtectedRoute />}>
            {/* Account-only routes */}
            <Route path="/account" element={<AccountLayout />}>
              <Route index element={<AccountRedirect />} />
              <Route element={<NoBusinessRoute />}>
                <Route path="create-business" element={<CreateBusiness />} />
              </Route>
              <Route path="settings" element={<AccountSettings />} />
            </Route>

            {/* Business-only routes */}
            <Route element={<BusinessRoute />}>
              <Route element={<BusinessLayout />}>
                <Route path="/dashboard" element={<Dashboard />} />
                <Route path="/phone" element={<Phone />} />
                <Route path="/history" element={<CallHistory />} />
                <Route path="/voicemail" element={<Voicemail />} />
                <Route path="/recordings" element={<Recordings />} />
                <Route element={<AdminRoute />}>
                  <Route path="/routing" element={<CallRouting />} />
                  <Route path="/team" element={<TeamManagement />} />
                  <Route path="/purchase" element={<Purchase />} />
                  <Route path="/billing" element={<Billing />} />
                </Route>
                <Route path="/support" element={<Support />} />
              </Route>
            </Route>
          </Route>
        </Routes>
          </BrowserRouter>
        </SoftphoneProvider>
      </AuthContextProvider>
    </div>
  );
}

export default App

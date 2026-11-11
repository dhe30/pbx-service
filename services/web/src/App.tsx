import { BrowserRouter, Routes, Route } from 'react-router-dom'

import { NavBar } from './components'
import { ProtectedRoute } from './routes/ProtectedRoute'
import { BusinessRoute } from './routes/BusinessRoute'
import { AdminRoute } from './routes/AdminRoute'
import { AccountRedirect } from './routes/AccountRedirect'
import { GuestRoute } from './routes/GuestRoute'
import {
  BusinessLayout,
  AccountLayout,
} from './layouts'
import { Landing } from './pages/public/Landing'
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
          {/* Public routes */}
          <Route element={<GuestRoute />}>
            <Route path="/" element={<Landing />} />
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
          </Route>

          {/* Protected routes */}
          <Route element={<ProtectedRoute />}>
            {/* Account-only routes */}
            <Route path="/account" element={<AccountLayout />}>
              <Route index element={<AccountRedirect />} />
              <Route path="create-business" element={<CreateBusiness />} />
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

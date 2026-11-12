import {
    createContext,
    useEffect,
    useCallback,
    useReducer,
    type ReactNode,
} from "react";
import axios from "axios";

import {
    authService,
    type LoginRequest,
    type RegisterRequest,
    type User,
} from "../services";

// State
interface AuthState {
    user: User | null;
    loading: boolean;
}

const initialState: AuthState = {
    user: null,
    loading: true,
};

// Actions
const AuthActions = {
    SET_USER: "set_user",
    LOGOUT: "logout",
    SET_LOADING: "set_loading",
} as const;

type AuthAction =
    | {
        type: typeof AuthActions.SET_USER;
        payload: User;
    }
    | {
        type: typeof AuthActions.LOGOUT;
    }
    | {
        type: typeof AuthActions.SET_LOADING;
        payload: boolean;
    };

// Reducer

function authReducer(state: AuthState, action: AuthAction): AuthState {
    switch (action.type) {
    case AuthActions.SET_USER:
        return {
            ...state,
            user: action.payload,
        };

    case AuthActions.LOGOUT:
        return {
            ...state,
            user: null,
        };

    case AuthActions.SET_LOADING:
        return {
            ...state,
            loading: action.payload,
        };

    default:
        return state;
    }
}

// Context interface

interface AuthContextType {
    user: User | null;
    loggedIn: boolean;
    loading: boolean;

    login: (credentials: LoginRequest) => Promise<void>;
    register: (credentials: RegisterRequest) => Promise<User>;
    logout: () => Promise<void>;
    updateUser: (user: User) => void;
}

export const AuthContext = createContext<AuthContextType | null>(null);

// Provider

export function AuthContextProvider({children,}: {children: ReactNode;}) {
    const [state, dispatch] = useReducer(authReducer, initialState);

    // Restore the session when the application starts.
    useEffect(() => {
        async function checkSession() {
            try {
                const user = await authService.getCurrentUser();

                dispatch({
                    type: AuthActions.SET_USER,
                    payload: user,
                });
            } catch (error) {
                if (!axios.isAxiosError(error) || error.response?.status !== 401) {
                    console.error("Failed to restore session:", error);
                }

                dispatch({
                    type: AuthActions.LOGOUT,
                });
            } finally {
                dispatch({
                    type: AuthActions.SET_LOADING,
                    payload: false,
                });
            }
        }

        checkSession();
    }, []);

    // Authentication methods

    async function login(credentials: LoginRequest) {
        const user = await authService.login(credentials);

        dispatch({
            type: AuthActions.SET_USER,
            payload: user,
        });
    }

    async function register(credentials: RegisterRequest): Promise<User> {
        const user = await authService.register(credentials);

        dispatch({
            type: AuthActions.SET_USER,
            payload: user,
        });
        return user;
    }

    async function logout() {
        try {
            await authService.logout();
        } finally {
            // Clear local authentication state even if the request fails.
            dispatch({
                type: AuthActions.LOGOUT,
            });
        }
    }

    const updateUser = useCallback((user: User) => {
        dispatch({
            type: AuthActions.SET_USER,
            payload: user,
        });
    }, []);

    const value: AuthContextType = {
        user: state.user,
        loggedIn: state.user !== null,
        loading: state.loading,
        login,
        register,
        logout,
        updateUser,
    };

    return (
        <AuthContext.Provider value={value}>
            {children}
        </AuthContext.Provider>
    );
}

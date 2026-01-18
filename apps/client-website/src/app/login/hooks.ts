'use client';

import { useState } from 'react';

import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import type { RegisterOptions, SubmitHandler } from 'react-hook-form';

import {
  dashboardLogin,
  type DashboardLoginPayload,
  type DashboardLoginResponse,
} from '@/lib/api/dashboardAuth';
import { useDashboardAuthStore } from '@/stores/dashboardAuthStore';

// Dashboard login form values - password only (AS-009)
export type LoginFormValues = {
  password: string;
};

export type LoginFieldConfig = {
  id: keyof LoginFormValues;
  label: string;
  placeholder: string;
  type: 'password';
  rules: RegisterOptions<LoginFormValues, keyof LoginFormValues>;
};

// Dashboard login uses password-only (AS-009)
export const loginFieldConfigs: LoginFieldConfig[] = [
  {
    id: 'password',
    label: 'Password',
    placeholder: 'Enter dashboard password',
    type: 'password',
    rules: {
      required: 'Password is required',
    },
  },
];

export const useLoginMutation = (): UseMutationResult<
  DashboardLoginResponse,
  Error,
  DashboardLoginPayload
> => {
  return useMutation<DashboardLoginResponse, Error, DashboardLoginPayload>({
    mutationFn: dashboardLogin,
  });
};

type UseLoginMutationHook = () => ReturnType<typeof useLoginMutation>;

export type LoginFlowResult = {
  dismissToast: () => void;
  handleLogin: SubmitHandler<LoginFormValues>;
  loginMutation: ReturnType<typeof useLoginMutation>;
  toastMessage: string | null;
};

export const useLoginFlow = (
  useLoginMutationHook: UseLoginMutationHook = useLoginMutation,
): LoginFlowResult => {
  const router = useRouter();
  const setAuthenticated = useDashboardAuthStore((state) => state.setAuthenticated);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const loginMutation = useLoginMutationHook();

  const handleLogin: SubmitHandler<LoginFormValues> = async (values) => {
    setToastMessage(null);

    try {
      await loginMutation.mutateAsync({
        password: values.password,
      });

      setAuthenticated(true);
      setToastMessage('Signed in. Redirecting to dashboard.');
      router.push('/home');
    } catch {
      setToastMessage(null);
    }
  };

  const dismissToast = (): void => {
    setToastMessage(null);
  };

  return { dismissToast, handleLogin, loginMutation, toastMessage };
};

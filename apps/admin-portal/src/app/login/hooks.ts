'use client';

import { useState } from 'react';

import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import type { RegisterOptions, SubmitHandler } from 'react-hook-form';

import { login, type LoginPayload } from '@/lib/api/login';
import { useUserStore } from '@/stores/userStore';

export type LoginFormValues = {
  email: string;
  password: string;
};

export type LoginFieldConfig = {
  id: keyof LoginFormValues;
  label: string;
  placeholder: string;
  type: 'email' | 'password';
  rules: RegisterOptions<LoginFormValues, keyof LoginFormValues>;
};

const emailPattern =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export const loginFieldConfigs: LoginFieldConfig[] = [
  {
    id: 'email',
    label: 'Email address',
    placeholder: 'you@domain.com',
    type: 'email',
    rules: {
      required: 'Email is required',
      pattern: {
        value: emailPattern,
        message: 'Enter a valid email address',
      },
    },
  },
  {
    id: 'password',
    label: 'Password',
    placeholder: '••••••••',
    type: 'password',
    rules: {
      required: 'Password is required',
      minLength: {
        value: 8,
        message: 'Use at least 8 characters',
      },
    },
  },
];

export const useLoginMutation = (): UseMutationResult<
  string,
  Error,
  LoginPayload
> => {
  return useMutation<string, Error, LoginPayload>({
    mutationFn: login,
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
  const setToken = useUserStore((state) => state.setToken);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const loginMutation = useLoginMutationHook();

  const handleLogin: SubmitHandler<LoginFormValues> = async (values) => {
    setToastMessage(null);

    try {
      const token = await loginMutation.mutateAsync({
        identifier: values.email,
        password: values.password,
      });

      setToken(token);
      setToastMessage('Signed in. Redirecting you home.');
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

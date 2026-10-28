export function createPlatformProfileHook(React) {
  let request;
  return function usePlatformProfile() {
    const [profile, setProfile] = React.useState(null);
    React.useEffect(() => {
      let active = true;
      request ??= fetch('/maa/api/auth/me', {credentials: 'same-origin', cache: 'no-store'})
        .then(response => response.ok ? response.json() : null)
        .then(data => {
          const user = data?.user;
          if (!user) return null;
          const github = typeof user.github === 'string' && /^[a-zA-Z0-9-]{1,39}$/.test(user.github) ? user.github : null;
          const displayName = github || user.email;
          if (typeof displayName !== 'string' || !displayName.trim()) return null;
          return {
            displayName,
            isProfileAvailable: false,
            profileImageUrl: github ? `https://github.com/${github}.png?size=64` : null,
          };
        })
        .catch(() => null);
      request.then(value => {if (active) setProfile(value);});
      return () => {active = false;};
    }, []);
    return profile;
  };
}

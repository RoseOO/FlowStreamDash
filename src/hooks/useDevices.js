import { useState, useEffect } from 'react';
export default function useDevices(apiFetch) {
  const [devices, setDevices] = useState([]);
  const [selectedSn, setSelectedSn] = useState('');
  useEffect(() => { apiFetch('/devices').then(setDevices); }, [apiFetch]);
  useEffect(() => { if (devices.length > 0 && !selectedSn) setSelectedSn(devices[0].sn); }, [devices, selectedSn]);
  return { devices, selectedSn, setSelectedSn };
}

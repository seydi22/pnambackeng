# Implémentation Frontend - Route d'export Nearby

## Description
Route pour exporter les données des marchands au format Excel avec deux feuilles : "Nearby Item" et "Location Map".

## Endpoint
```
GET /api/export/nearby
```

## Authentification
La route nécessite une authentification avec un token JWT et le rôle "admin".

## Paramètres de requête (optionnels)
- `startDate` : Date de début au format ISO (ex: `2024-01-01`)
- `endDate` : Date de fin au format ISO (ex: `2024-12-31`)

## Exemples d'utilisation

### Exemple 1 : Export sans filtre de date
```javascript
const exportNearby = async () => {
  try {
    const token = localStorage.getItem('token'); // ou votre méthode de stockage du token
    
    const response = await fetch('/api/export/nearby', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        // ou selon votre système d'auth
        // 'x-auth-token': token
      }
    });

    if (!response.ok) {
      throw new Error('Erreur lors de l\'export');
    }

    // Récupérer le blob du fichier Excel
    const blob = await response.blob();
    
    // Créer un lien de téléchargement
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `export_nearby_${new Date().toISOString().split('T')[0]}.xlsx`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
    
  } catch (error) {
    console.error('Erreur:', error);
    // Afficher un message d'erreur à l'utilisateur
  }
};
```

### Exemple 2 : Export avec filtre de date
```javascript
const exportNearbyWithDateFilter = async (startDate, endDate) => {
  try {
    const token = localStorage.getItem('token');
    
    // Construire l'URL avec les paramètres de date
    const params = new URLSearchParams();
    if (startDate) params.append('startDate', startDate);
    if (endDate) params.append('endDate', endDate);
    
    const url = `/api/export/nearby${params.toString() ? '?' + params.toString() : ''}`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
      }
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.msg || 'Erreur lors de l\'export');
    }

    // Télécharger le fichier
    const blob = await response.blob();
    const urlBlob = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = urlBlob;
    a.download = `export_nearby_${startDate || 'all'}_${endDate || 'all'}.xlsx`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(urlBlob);
    document.body.removeChild(a);
    
  } catch (error) {
    console.error('Erreur:', error);
    alert('Erreur lors de l\'export: ' + error.message);
  }
};
```

### Exemple 3 : Avec Axios
```javascript
import axios from 'axios';

const exportNearby = async (startDate = null, endDate = null) => {
  try {
    const params = {};
    if (startDate) params.startDate = startDate;
    if (endDate) params.endDate = endDate;

    const response = await axios.get('/api/export/nearby', {
      params,
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('token')}`
      },
      responseType: 'blob' // Important pour les fichiers binaires
    });

    // Créer et télécharger le fichier
    const url = window.URL.createObjectURL(new Blob([response.data]));
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `export_nearby_${Date.now()}.xlsx`);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
    
  } catch (error) {
    console.error('Erreur export:', error);
    if (error.response?.data) {
      // Si le backend renvoie une erreur JSON
      const reader = new FileReader();
      reader.onload = () => {
        const errorData = JSON.parse(reader.result);
        alert(errorData.msg || 'Erreur lors de l\'export');
      };
      reader.readAsText(error.response.data);
    } else {
      alert('Erreur lors de l\'export');
    }
  }
};
```

### Exemple 4 : Composant React avec bouton
```jsx
import React, { useState } from 'react';
import axios from 'axios';

const ExportNearbyButton = () => {
  const [loading, setLoading] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const handleExport = async () => {
    setLoading(true);
    try {
      const params = {};
      if (startDate) params.startDate = startDate;
      if (endDate) params.endDate = endDate;

      const response = await axios.get('/api/export/nearby', {
        params,
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        responseType: 'blob'
      });

      // Télécharger le fichier
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `export_nearby_${new Date().toISOString().split('T')[0]}.xlsx`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      
      alert('Export réussi !');
    } catch (error) {
      console.error('Erreur:', error);
      alert('Erreur lors de l\'export');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h3>Export Nearby</h3>
      <div>
        <label>
          Date de début :
          <input 
            type="date" 
            value={startDate} 
            onChange={(e) => setStartDate(e.target.value)} 
          />
        </label>
        <label>
          Date de fin :
          <input 
            type="date" 
            value={endDate} 
            onChange={(e) => setEndDate(e.target.value)} 
          />
        </label>
      </div>
      <button onClick={handleExport} disabled={loading}>
        {loading ? 'Export en cours...' : 'Exporter Nearby'}
      </button>
    </div>
  );
};

export default ExportNearbyButton;
```

## Réponses possibles

### Succès (200)
- Type de contenu : `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
- Corps : Fichier Excel binaire
- Headers :
  - `Content-Disposition: attachment; filename=export_nearby_YYYYMMDD_HHmm_xxx.xlsx`

### Erreur 404
```json
{
  "msg": "Aucun marchand validé à exporter."
}
```

### Erreur 500
```json
{
  "msg": "Erreur du serveur lors de la génération de l'export nearby."
}
```

## Notes importantes

1. **Type de réponse** : La réponse est un fichier binaire (blob), pas du JSON
2. **Authentification** : Assurez-vous que le token est valide et que l'utilisateur a le rôle "admin"
3. **Format des dates** : Utilisez le format ISO (YYYY-MM-DD) pour les dates
4. **Gestion des erreurs** : En cas d'erreur, le backend peut renvoyer du JSON, vérifiez le `Content-Type` de la réponse
5. **Nom du fichier** : Le backend génère automatiquement un nom unique, mais vous pouvez aussi utiliser votre propre nom

## Structure du fichier Excel exporté

Le fichier Excel contient deux feuilles :

1. **Nearby Item** : Contient les données des marchands avec les colonnes :
   - Item Name
   - Nearby Type ID (toujours 40001)
   - Province Code (HUNAN par défaut)
   - City Code (CHANGSHA par défaut)
   - Zone Code (YUELU par défaut)
   - Longitude
   - Latitude
   - Phone Number
   - Title
   - Detailed Address

2. **Location Map** : Contient le mapping des provinces, villes et zones
